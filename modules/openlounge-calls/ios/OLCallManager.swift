import AVFoundation
import CallKit
import Foundation
import PushKit
import Security
import UIKit

// Native call ringing for Open Lounge (NATIVE_SPEC.md §3).
//
//   VoIP push (PushKit) ─▶ report a CallKit incoming call IMMEDIATELY (iOS kills/throttles apps that don't)
//   CallKit Answer      ─▶ JS opens https://openlounge.app/call/<id>?accept=1 in the WebView
//   CallKit Decline     ─▶ POST /api/calls/<id>/decline natively (works with the WebView not loaded). Build 19: with
//                          the push's per-call decline token (X-Call-Decline-Token: call+callee scoped, expires with
//                          the ring, single-use), so Decline works even when the 1-hour session has expired.
//   CallKit End/Mute    ─▶ JS injects openlounge:native-call {call:hangup | call:mute}
//   page call:*         ─▶ mirror into CallKit (outgoing call, connected, ended, muted) + audio route
//
// Audio: while a call is up the app's AVAudioSession is playAndRecord + voiceChat/videoChat with
// defaultToSpeaker + Bluetooth, so ringback and the call never land on the earpiece unexpectedly;
// the previous category is restored afterwards. All state lives on the main queue.

final class OLCall {
  let callId: String
  let uuid: UUID
  let incoming: Bool
  var video: Bool
  var answered = false
  var answeredInPage = false
  var ended = false
  var expiresAt: Date?
  var declineToken: String?
  var expiryTimer: Timer?
  var pollTimer: Timer?

  init(callId: String, uuid: UUID, incoming: Bool, video: Bool) {
    self.callId = callId
    self.uuid = uuid
    self.incoming = incoming
    self.video = video
  }
}

enum OLCallAuth {
  private static let service = "com.donnydey.openlounge.calls"
  private static let account = "access"

  private static func baseQuery() -> [String: Any] {
    return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  static func save(token: String, expMs: Double) {
    SecItemDelete(baseQuery() as CFDictionary)
    guard !token.isEmpty, token.count < 8192, expMs > 0,
          let data = try? JSONSerialization.data(withJSONObject: ["t": token, "exp": expMs]) else { return }
    var add = baseQuery()
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    SecItemAdd(add as CFDictionary, nil)
  }

  /// A token that is still valid for at least 10 s, or nil.
  static func fresh() -> String? {
    var q = baseQuery()
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data,
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let t = obj["t"] as? String, let exp = (obj["exp"] as? NSNumber)?.doubleValue else { return nil }
    return exp > Date().timeIntervalSince1970 * 1000 + 10_000 ? t : nil
  }
}

public final class OLCallManager: NSObject, PKPushRegistryDelegate, CXProviderDelegate {
  public static let shared = OLCallManager()
  #if targetEnvironment(simulator)
  // Simulator CI only: SIMCTL_CHILD_OL_SIM_API_BASE=http://127.0.0.1:8787 points native calls at the CI decline server.
  private static var base: URL {
    if let s = ProcessInfo.processInfo.environment["OL_SIM_API_BASE"], s.hasPrefix("http://127.0.0.1:"), let u = URL(string: s) { return u }
    return URL(string: "https://openlounge.app")!
  }
  #else
  private static let base = URL(string: "https://openlounge.app")!
  #endif
  private static let idPattern = "^[A-Za-z0-9_-]{1,64}$"
  private static let declineTokenPattern = "^v1\\.[A-Za-z0-9_-]{8,500}\\.[A-Za-z0-9_-]{20,100}$"

  private var started = false
  private var registry: PKPushRegistry?
  private var provider: CXProvider?
  private let controller = CXCallController()
  private var calls: [UUID: OLCall] = [:]

  // shared with the JS thread
  private let lock = NSLock()
  private var token = ""
  private var pending: [[String: Any]] = []
  private var jsReady = false
  private weak var module: OpenLoungeCallsModule?

  // audio
  private var savedAudio: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?
  private var speaker = true
  private var callVideo = false
  private var pageMuted: Bool?

  // MARK: - lifecycle / JS

  func start() {
    if started { return }
    started = true
    let cfg = CXProviderConfiguration()
    cfg.supportsVideo = true
    cfg.maximumCallGroups = 1
    cfg.maximumCallsPerCallGroup = 1
    cfg.supportedHandleTypes = [.generic]
    cfg.includesCallsInRecents = false
    let p = CXProvider(configuration: cfg)
    p.setDelegate(self, queue: nil) // main queue
    provider = p

    NotificationCenter.default.addObserver(
      self, selector: #selector(onRouteChange(_:)),
      name: AVAudioSession.routeChangeNotification, object: nil)
    prepareHeadsetSession()

    let r = PKPushRegistry(queue: DispatchQueue.main)
    r.delegate = self
    r.desiredPushTypes = [.voIP]
    registry = r
    NSLog("[OLCalls] PushKit + CallKit ready")

    // Simulator CI only (simctl launch with SIMCTL_CHILD_OL_SIM_RING=1): ring once through the normal push path.
    if ProcessInfo.processInfo.environment["OL_SIM_RING"] == "1" {
      DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
        let exp = Int((Date().timeIntervalSince1970 + 45) * 1000)
        self.handleIncoming(["type": "call_incoming", "callId": "simring1", "callerId": "u_sim", "callerName": "Sim Test",
                             "video": "0", "expiresAt": String(exp)], completion: {})
      }
    }
    #if targetEnvironment(simulator)
    // Simulator CI only: the CI sim has no CallKit host UI, so drive the native Decline request directly with the
    // push's decline token and NO session (nothing signed in): first → 200, the replay → 409.
    let env = ProcessInfo.processInfo.environment
    if let tok = env["OL_SIM_DECLINE_TOKEN"], !tok.isEmpty {
      let cid = env["OL_SIM_DECLINE_CALL"] ?? "simdecline1"
      for delay in [4.0, 9.0] {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
          NSLog("[OLCalls] sim: native decline with the push's decline token (session: %@)", OLCallAuth.fresh() == nil ? "none" : "fresh")
          self.declineOnServer(cid, declineToken: tok)
        }
      }
    }
    #endif
  }

  func attach(_ m: OpenLoungeCallsModule) {
    lock.lock(); module = m; jsReady = false; lock.unlock()
  }

  func detach(_ m: OpenLoungeCallsModule) {
    lock.lock(); if module === m { module = nil; jsReady = false }; lock.unlock()
  }

  /// Marks JS as listening and returns (then clears) actions that happened before, e.g. Answer on a cold start.
  func markReady() -> String {
    lock.lock()
    jsReady = true
    let now = Date().timeIntervalSince1970 * 1000
    let out = pending.filter { (($0["at"] as? Double) ?? 0) > now - 120_000 }
    pending.removeAll()
    lock.unlock()
    return Self.json(out)
  }

  var voipToken: String {
    lock.lock(); defer { lock.unlock() }
    return token
  }

  private func emit(_ action: [String: Any]) {
    var a = action
    a["at"] = Date().timeIntervalSince1970 * 1000
    lock.lock()
    let m = jsReady ? module : nil
    if m == nil {
      pending.append(a)
      if pending.count > 16 { pending.removeFirst() }
    }
    lock.unlock()
    m?.sendEvent("onCallAction", ["json": Self.json(a)])
  }

  private static func json(_ v: Any) -> String {
    guard let d = try? JSONSerialization.data(withJSONObject: v), let s = String(data: d, encoding: .utf8) else { return "[]" }
    return s
  }

  private static func valid(_ id: String) -> Bool {
    return id.range(of: idPattern, options: .regularExpression) != nil
  }

  private func call(_ callId: String) -> OLCall? {
    return calls.values.first { $0.callId == callId && !$0.ended }
  }

  private var hasLiveCall: Bool { calls.values.contains { !$0.ended } }

  // MARK: - PushKit

  public func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
    guard type == .voIP else { return }
    let hex = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
    lock.lock(); token = hex; let m = jsReady ? module : nil; lock.unlock()
    m?.sendEvent("onVoipToken", ["token": hex])
  }

  public func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    guard type == .voIP else { return }
    lock.lock(); token = ""; let m = jsReady ? module : nil; lock.unlock()
    m?.sendEvent("onVoipToken", ["token": ""])
  }

  public func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload,
                           for type: PKPushType, completion: @escaping () -> Void) {
    guard type == .voIP else { completion(); return }
    var d: [String: String] = [:]
    for (k, v) in payload.dictionaryPayload {
      guard let key = k as? String else { continue }
      if let s = v as? String { d[key] = s } else if let n = v as? NSNumber { d[key] = n.stringValue }
    }
    handleIncoming(d, completion: completion)
  }

  private func handleIncoming(_ d: [String: String], completion: @escaping () -> Void) {
    guard let provider = provider else { completion(); return }
    let callId = d["callId"] ?? ""
    let ok = Self.valid(callId)
    var name = String((d["callerName"] ?? "").prefix(80)).trimmingCharacters(in: .whitespacesAndNewlines)
    if name.isEmpty { name = "Open Lounge" }
    let video = d["video"] == "1" || d["video"] == "true"
    var expires: Date?
    if let e = d["expiresAt"], let ms = Double(e), ms > 0 { expires = Date(timeIntervalSince1970: ms / 1000) }
    let declineToken = d["declineToken"].flatMap { $0.range(of: Self.declineTokenPattern, options: .regularExpression) != nil ? $0 : nil }

    let update = CXCallUpdate()
    let handle = (d["callerId"] ?? "").isEmpty ? name : d["callerId"]!
    update.remoteHandle = CXHandle(type: .generic, value: String(handle.prefix(80)))
    update.localizedCallerName = name
    update.hasVideo = video
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false

    // Duplicate push for a call that's already ringing: it still has to be reported (same UUID → harmless error).
    if ok, let existing = call(callId) {
      provider.reportNewIncomingCall(with: existing.uuid, update: update) { _ in DispatchQueue.main.async { completion() } }
      return
    }

    // Every VoIP push must produce a reported call, even ones we won't ring for (then it's ended right away).
    let stale = !ok || (d["type"] ?? "call_incoming") != "call_incoming" || (expires.map { $0.timeIntervalSinceNow <= 1 } ?? false)
    let busy = !stale && hasLiveCall
    let uuid = UUID()
    let c = OLCall(callId: ok ? callId : "", uuid: uuid, incoming: true, video: video)
    c.expiresAt = expires
    c.declineToken = declineToken
    if !stale && !busy { calls[uuid] = c }

    provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
      DispatchQueue.main.async {
        completion()
        guard let self = self else { return }
        if let error = error {
          // Do Not Disturb / blocked / call limit: nothing rings.
          NSLog("[OLCalls] incoming call not shown: %@", error.localizedDescription)
          self.calls[uuid] = nil
          return
        }
        NSLog("[OLCalls] incoming call reported (stale=%d busy=%d)", stale ? 1 : 0, busy ? 1 : 0)
        if stale || busy {
          self.provider?.reportCall(with: uuid, endedAt: nil, reason: busy ? .unanswered : .remoteEnded)
          if busy { self.declineOnServer(callId, declineToken: declineToken) } // already in a call → reject as busy
          return
        }
        self.armRinging(c)
      }
    }
  }

  private func armRinging(_ c: OLCall) {
    let deadline = c.expiresAt ?? Date().addingTimeInterval(60)
    let left = max(1, min(120, deadline.timeIntervalSinceNow))
    c.expiryTimer = Timer.scheduledTimer(withTimeInterval: left, repeats: false) { [weak self] _ in
      self?.endRinging(c, reason: .unanswered)
    }
    // The caller may hang up / another device may answer: a call_cancel FCM data message ends it via JS, and as a
    // backstop the call is polled while it rings (if a fresh access token is stored; rate limit is 30/min).
    c.pollTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
      self?.poll(c)
    }
  }

  private func stopTimers(_ c: OLCall) {
    c.expiryTimer?.invalidate(); c.expiryTimer = nil
    c.pollTimer?.invalidate(); c.pollTimer = nil
  }

  private func endRinging(_ c: OLCall, reason: CXCallEndedReason) {
    guard calls[c.uuid] === c, !c.ended, !c.answered else { return }
    c.ended = true
    stopTimers(c)
    calls[c.uuid] = nil
    provider?.reportCall(with: c.uuid, endedAt: nil, reason: reason)
    restoreAudioIfIdle()
  }

  private func poll(_ c: OLCall) {
    guard calls[c.uuid] === c, !c.answered, !c.ended else { stopTimers(c); return }
    guard let t = OLCallAuth.fresh() else { c.pollTimer?.invalidate(); c.pollTimer = nil; return }
    var req = URLRequest(url: Self.base.appendingPathComponent("api/calls/\(c.callId)"))
    req.timeoutInterval = 8
    req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization")
    URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
      let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
      var phase = ""
      if let data = data, let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         let call = o["call"] as? [String: Any], let p = call["phase"] as? String { phase = p }
      DispatchQueue.main.async {
        guard let self = self else { return }
        if status == 404 || phase == "ended" { self.endRinging(c, reason: .remoteEnded) }
        else if phase == "active" { self.endRinging(c, reason: .answeredElsewhere) }
        else if status == 401 || status == 403 { c.pollTimer?.invalidate(); c.pollTimer = nil }
      }
    }.resume()
  }

  /// From JS: FCM call_cancel {callId, reason} (background data message) → stop the ring.
  func endExternally(callId: String, reason: String) {
    guard let c = call(callId), c.incoming, !c.answered else { return }
    let r: CXCallEndedReason
    switch reason {
    case "answered_elsewhere": r = .answeredElsewhere
    case "declined_elsewhere": r = .declinedElsewhere
    case "timeout", "missed", "expired": r = .unanswered
    default: r = .remoteEnded
    }
    endRinging(c, reason: r)
  }

  /// Sends the per-call decline token (works with no session) and the access token too when it's fresh (the server
  /// falls back to the session if the token is refused). Any 2xx/4xx answer is final: 409 = already declined/answered.
  private func declineOnServer(_ callId: String, declineToken: String?) {
    guard Self.valid(callId) else { return }
    let t = OLCallAuth.fresh()
    if t == nil && declineToken == nil {
      NSLog("[OLCalls] decline not sent: no decline token and no fresh access token (the caller's ring times out instead)")
      return
    }
    var req = URLRequest(url: Self.base.appendingPathComponent("api/calls/\(callId)/decline"))
    req.httpMethod = "POST"
    req.timeoutInterval = 15
    if let dt = declineToken { req.setValue(dt, forHTTPHeaderField: "X-Call-Decline-Token") }
    if let t = t { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = Data("{}".utf8)
    var bg = UIBackgroundTaskIdentifier.invalid
    let finish = {
      if bg != .invalid { UIApplication.shared.endBackgroundTask(bg); bg = .invalid }
    }
    bg = UIApplication.shared.beginBackgroundTask(withName: "openlounge-decline") { finish() }
    URLSession.shared.dataTask(with: req) { _, resp, _ in
      NSLog("[OLCalls] decline → %d (%@)", (resp as? HTTPURLResponse)?.statusCode ?? 0, declineToken != nil ? (t != nil ? "decline token + session" : "decline token") : "session")
      DispatchQueue.main.async { finish() }
    }.resume()
  }

  // MARK: - CallKit

  public func providerDidReset(_ provider: CXProvider) {
    for c in calls.values {
      stopTimers(c)
      if c.answered || !c.incoming { emit(["type": "hangup", "callId": c.callId]) }
    }
    calls.removeAll()
    restoreAudioIfIdle()
  }

  public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    guard let c = calls[action.callUUID], !c.ended else { action.fail(); return }
    c.answered = true
    stopTimers(c)
    callVideo = c.video
    configureAudio()
    action.fulfill()
    if !c.answeredInPage { emit(["type": "answer", "callId": c.callId, "video": c.video]) }
  }

  public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    guard let c = calls[action.callUUID] else { action.fulfill(); return }
    c.ended = true
    stopTimers(c)
    calls[action.callUUID] = nil
    if c.incoming && !c.answered {
      declineOnServer(c.callId, declineToken: c.declineToken)
      c.declineToken = nil // single-use
      emit(["type": "decline", "callId": c.callId])
    } else {
      emit(["type": "hangup", "callId": c.callId])
    }
    action.fulfill()
    restoreAudioIfIdle()
  }

  public func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    action.fulfill()
    if pageMuted == action.isMuted { return } // echo of a page-initiated change
    pageMuted = action.isMuted
    emit(["type": "mute", "muted": action.isMuted])
  }

  public func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    guard let c = calls[action.callUUID] else { action.fail(); return }
    callVideo = c.video
    configureAudio()
    provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
    action.fulfill()
  }

  public func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
    action.fail() // holding isn't supported
  }

  public func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
    action.fulfill()
  }

  public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    configureAudio()
    // CallKit activating the session (outgoing CXStartCallAction, or answer) interrupts WebKit's AudioContext and
    // pauses the page's ring <audio>: the web ringback went silent the moment the call was mirrored into CallKit.
    // Tell JS so it re-runs the page's audio resume (AudioContext + ring element) on the new session.
    emit(["type": "audio", "reason": "callkit-activate"])
    // WebKit re-binds its audio units a few hundred ms after CallKit hands over the session; a single kick can land
    // before that and the ring <audio> / remote voice stays paused (ring "plays briefly then stops", silent audio-only
    // call). Re-kick twice more — the page side is idempotent.
    for delay in [0.35, 1.2] {
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
        guard let self = self, self.hasLiveCall else { return }
        self.emit(["type": "audio", "reason": "callkit-activate-settle"])
      }
    }
  }

  public func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {}

  // MARK: - page → native (src/calls.ts forwards {type:"call:*"} bridge messages)

  func handlePage(_ json: String) {
    guard let data = json.data(using: .utf8),
          let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let type = m["type"] as? String else { return }
    let callId = (m["callId"] as? String) ?? ""
    switch type {
    case "call:incoming":
      // Page got call:incoming over WS while App Lock is up — report CallKit the same way a VoIP push would.
      guard Self.valid(callId), call(callId) == nil, !hasLiveCall else { return }
      let video = (m["video"] as? Bool) ?? false
      var name = String(((m["name"] as? String) ?? "").prefix(80)).trimmingCharacters(in: .whitespacesAndNewlines)
      if name.isEmpty { name = "Open Lounge" }
      let expires: Date? = {
        if let ms = m["expiresAt"] as? Double { return Date(timeIntervalSince1970: ms / 1000) }
        if let ms = m["expiresAt"] as? Int { return Date(timeIntervalSince1970: Double(ms) / 1000) }
        return Date().addingTimeInterval(45)
      }()
      let uuid = UUID()
      let c = OLCall(callId: callId, uuid: uuid, incoming: true, video: video)
      c.expiresAt = expires
      calls[uuid] = c
      let update = CXCallUpdate()
      update.remoteHandle = CXHandle(type: .generic, value: name)
      update.localizedCallerName = name
      update.hasVideo = video
      update.supportsHolding = false
      update.supportsGrouping = false
      update.supportsUngrouping = false
      update.supportsDTMF = false
      provider?.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
        DispatchQueue.main.async {
          guard let self = self else { return }
          if let error = error {
            NSLog("[OLCalls] page incoming CallKit refused: %@", error.localizedDescription)
            self.calls[uuid] = nil
            return
          }
          self.armRinging(c)
        }
      }

    case "call:outgoing":
      let video = (m["video"] as? Bool) ?? false
      callVideo = video
      speaker = true
      guard Self.valid(callId), call(callId) == nil, !hasLiveCall else { configureAudio(); return }
      var name = String(((m["name"] as? String) ?? "").prefix(80)).trimmingCharacters(in: .whitespacesAndNewlines)
      if name.isEmpty { name = "Open Lounge" }
      let c = OLCall(callId: callId, uuid: UUID(), incoming: false, video: video)
      calls[c.uuid] = c
      let a = CXStartCallAction(call: c.uuid, handle: CXHandle(type: .generic, value: name))
      a.isVideo = video
      a.contactIdentifier = name
      controller.request(CXTransaction(action: a)) { [weak self] err in
        DispatchQueue.main.async {
          guard let self = self else { return }
          if let err = err {
            NSLog("[OLCalls] outgoing CallKit call refused: %@", err.localizedDescription)
            self.calls[c.uuid] = nil
            self.configureAudio() // still route ringback to the speaker
            return
          }
          let u = CXCallUpdate()
          u.remoteHandle = CXHandle(type: .generic, value: name)
          u.localizedCallerName = name
          u.hasVideo = video
          u.supportsHolding = false
          u.supportsGrouping = false
          u.supportsUngrouping = false
          u.supportsDTMF = false
          self.provider?.reportCall(with: c.uuid, updated: u)
        }
      }

    case "call:connected":
      if let c = call(callId) {
        stopTimers(c)
        callVideo = c.video
        if c.incoming && !c.answered {
          // answered on the page's own ring screen: move CallKit to the answered state without navigating again
          c.answeredInPage = true
          controller.request(CXTransaction(action: CXAnswerCallAction(call: c.uuid))) { _ in }
        } else if !c.incoming {
          provider?.reportOutgoingCall(with: c.uuid, connectedAt: Date())
        }
      }
      configureAudio()

    case "call:ended":
      let targets = calls.values.filter { !$0.ended && (callId.isEmpty || $0.callId == callId) }
      for c in targets {
        c.ended = true
        stopTimers(c)
        calls[c.uuid] = nil
        provider?.reportCall(with: c.uuid, endedAt: Date(), reason: .remoteEnded)
      }
      pageMuted = nil
      restoreAudioIfIdle(force: true)

    case "call:muted":
      guard let muted = m["muted"] as? Bool else { return }
      pageMuted = muted
      if let c = calls.values.first(where: { !$0.ended && ($0.answered || !$0.incoming) }) {
        controller.request(CXTransaction(action: CXSetMutedCallAction(call: c.uuid, muted: muted))) { _ in }
      }

    case "call:audioRoute":
      guard let sp = m["speaker"] as? Bool else { return }
      speaker = sp
      configureAudio()

    default:
      return
    }
  }

  // MARK: - audio session

  /// Wired, USB-C/Lightning, Bluetooth HFP/LE and CarPlay outputs that carry their own mic / are personal audio.
  static func headsetAttached(_ route: AVAudioSessionRouteDescription = AVAudioSession.sharedInstance().currentRoute) -> Bool {
    let ports: Set<AVAudioSession.Port> = [.headphones, .headsetMic, .bluetoothHFP, .bluetoothA2DP, .bluetoothLE, .usbAudio, .carAudio]
    return route.outputs.contains { ports.contains($0.portType) } || route.inputs.contains { ports.contains($0.portType) }
  }

  /// Rooms (WebRTC in WKWebView) and calls: playAndRecord that lets a headset's mic and speaker route automatically,
  /// and the loudspeaker only when nothing is attached.
  private func prepareHeadsetSession() {
    let s = AVAudioSession.sharedInstance()
    var opts: AVAudioSession.CategoryOptions = [.allowBluetooth, .allowBluetoothA2DP]
    if !Self.headsetAttached() { opts.insert(.defaultToSpeaker) }
    try? s.setCategory(.playAndRecord, mode: .default, options: opts)
  }

  @objc private func onRouteChange(_ n: Notification) {
    DispatchQueue.main.async {
      let headset = Self.headsetAttached()
      if self.savedAudio != nil { self.configureAudio() } else { self.prepareHeadsetSession() }
      let out = AVAudioSession.sharedInstance().currentRoute.outputs.first
      var reason = 0
      if let v = n.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt { reason = Int(v) }
      self.emit(["type": "audioRoute", "headset": headset, "port": out?.portType.rawValue ?? "", "name": out?.portName ?? "", "reason": reason])
    }
  }

  private func configureAudio() {
    let s = AVAudioSession.sharedInstance()
    if savedAudio == nil { savedAudio = (s.category, s.mode, s.categoryOptions) }
    var opts: AVAudioSession.CategoryOptions = [.allowBluetooth, .allowBluetoothA2DP]
    let headset = Self.headsetAttached()
    // never force the loudspeaker while a headset is attached; it falls back to speaker when removed
    if speaker && !headset { opts.insert(.defaultToSpeaker) }
    do {
      try s.setCategory(.playAndRecord, mode: callVideo ? .videoChat : .voiceChat, options: opts)
    } catch {
      NSLog("[OLCalls] setCategory failed: %@", error.localizedDescription)
    }
    do {
      try s.overrideOutputAudioPort(speaker && !headset ? .speaker : .none)
    } catch {
      // fails while the session is inactive; defaultToSpeaker covers that case
    }
  }

  private func restoreAudioIfIdle(force: Bool = false) {
    guard !hasLiveCall, let saved = savedAudio else { return }
    savedAudio = nil
    speaker = true
    callVideo = false
    pageMuted = nil
    let s = AVAudioSession.sharedInstance()
    try? s.overrideOutputAudioPort(.none)
    try? s.setCategory(saved.0, mode: saved.1, options: saved.2)
    prepareHeadsetSession()
    _ = force
  }
}
