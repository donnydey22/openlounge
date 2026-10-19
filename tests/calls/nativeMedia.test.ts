import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type Ev = { type: string; detail?: unknown };
function installWindow(bridge: Record<string, unknown> | null) {
  const target = new EventTarget();
  const w = {
    OpenLoungeNative: bridge ?? undefined,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
  (globalThis as { window?: unknown }).window = w;
  (globalThis as { CustomEvent?: unknown }).CustomEvent ??= class extends Event {
    detail: unknown;
    constructor(t: string, o?: { detail?: unknown }) { super(t); this.detail = o?.detail; }
  };
  return w as typeof w & Record<string, unknown>;
}

function fakeSocket() {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  const sent: Array<{ ev: string; data: unknown }> = [];
  return {
    sent,
    on(ev: string, fn: (d: unknown) => void) { (handlers.get(ev) ?? handlers.set(ev, new Set()).get(ev)!).add(fn); },
    off(ev: string, fn: (d: unknown) => void) { handlers.get(ev)?.delete(fn); },
    emit(ev: string, d: unknown) { handlers.get(ev)?.forEach((f) => f(d)); },
    async request(ev: string, data: unknown) { sent.push({ ev, data }); return { ok: true, echo: ev }; },
  };
}

test("native media: iOS voice stays native and an explicit paired-video grant is the only video exception", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  installWindow(null);
  assert.equal(m.useNativeMedia(false), false, "Safari / web: never");
  installWindow({ capabilities: ["calls"], nativeMedia: async () => true, msReply() {} });
  assert.equal(m.useNativeMedia(false), false, "older iOS app without the capability");
  installWindow({ capabilities: ["calls", "nativeMedia"], nativeMedia: async () => true, msReply() {} });
  assert.equal(m.useNativeMedia(false), true);
  assert.equal(m.useNativeMedia(true), false, "older binaries keep WebView video");
  installWindow({ capabilities: ["calls", "nativeMedia", "nativeVideo"], nativeMedia: async () => true, msReply() {} });
  assert.equal(m.useNativeMedia(true, { iosNativeVideo: true } as never), true, "only the server grant enables paired native video");
  assert.equal(m.useNativeMedia(true, { iosNativeVideo: false } as never), false);
});

test("native media: page relays the app's ms:* signaling for this call only, forwards consumer notices, maps state", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  const cmds: Record<string, unknown>[] = [];
  const replies: Array<[string, boolean, unknown, string | undefined]> = [];
  const w = installWindow({
    capabilities: ["calls", "nativeMedia"],
    nativeMedia: async (c: Record<string, unknown>) => { cmds.push(c); return c.op === "stats" ? [[{ id: "a", type: "transport" }]] : true; },
    msReply: (id: string, ok: boolean, r: unknown, e?: string) => replies.push([id, ok, r, e]),
  });
  const sock = fakeSocket();
  const states: string[] = [];
  const s = new m.NativeMediaSession(sock as never, { provider: "mediasoup", callId: "c1", iceServers: [{ urls: "turn:x" }] } as never, {
    onRemoteTrack() {}, onState: (st) => states.push(st), onLocalVideo() {}, tcpOnly: true,
  });
  await s.connect(false);
  assert.deepEqual(cmds[0], { op: "connect", callId: "c1", iceServers: [{ urls: "turn:x" }], video: false, nativeVideo: false, tcpOnly: true });
  const relay = w.__olNativeMsReq as (id: string, ev: string, d: Record<string, unknown>) => void;
  relay("r1", "ms:join", { callId: "c1" });
  relay("r2", "ms:join", { callId: "other" });
  relay("r3", "auth:verify", { callId: "c1" });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sock.sent, [{ ev: "ms:join", data: { callId: "c1" } }]);
  assert.deepEqual(replies.find((x) => x[0] === "r1")?.slice(0, 2), ["r1", true]);
  assert.equal(replies.find((x) => x[0] === "r2")?.[1], false);
  assert.equal(replies.find((x) => x[0] === "r3")?.[1], false);
  sock.emit("ms:consumer:available", {});
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(cmds.some((c) => c.op === "consumerAvailable"));
  window.dispatchEvent(new CustomEvent("openlounge:native-media", { detail: { state: "disconnected" } }));
  window.dispatchEvent(new CustomEvent("openlounge:native-media", { detail: { state: "connected" } }));
  assert.deepEqual(states, ["disconnected", "connected"]);
  await s.setMuted(true);
  assert.ok(cmds.some((c) => c.op === "mute" && c.muted === true));
  const stats = await s.getTransportStats();
  assert.equal((stats[0] as unknown as Map<string, unknown>).size, 1);
  s.close();
  assert.equal(w.__olNativeMsReq, undefined);
  assert.ok(cmds.some((c) => c.op === "close"));
});

test("engine: native-media mode skips WebView getUserMedia on dial and defers an iPhone video session until its grant", () => {
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  // An explicitly granted iPhone video caller must never let WKWebView acquire its microphone first.
  assert.match(src, /iosNativeVideoAvailable/);
  assert.match(src, /this\.preMic = Promise\.resolve\(null\)/);
  assert.match(src, /if \(this\.media\?\.iosNativeVideo\) this\.deferNativeConnect/);
  assert.match(src, /if \(this\.deferNativeConnect\) \{\s*this\.deferNativeConnect = false;\s*void this\.connect\(false\);/);
  assert.match(src, /const Session = useNativeMedia\([^)]*\) && this\.iosNativeVideoWebFallbackCall !== this\.s\.call\?\.id \? NativeMediaSession : MediasoupCallSession/);
  assert.match(src, /media\.provider === "mediasoup" \|\| \(useNativeMedia\([^)]*\) && this\.iosNativeVideoWebFallbackCall !== this\.s\.call\?\.id\)/);
});

test("server: native SFU connection is stable across page sockets and survives a reload window", async () => {
  const m = await import("../../server/calls/index");
  assert.equal(m.nativeConnectionFor("sock1", "u1", undefined), "sock1", "web path unchanged");
  assert.equal(m.nativeConnectionFor("sock1", "u1", "bad id!"), null);
  const id = m.nativeConnectionFor("sock1", "u1", "n_abc12345");
  assert.equal(id, "native:u1:n_abc12345");
  const expired: string[] = [];
  m.nativeSocketClosed("sock1", (c: string) => void expired.push(c), 30);
  // reloaded page relays again from a new socket before the window ends → no teardown
  assert.equal(m.nativeConnectionFor("sock2", "u1", "n_abc12345"), id);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(expired.length, 0);
  // app gone: the new socket closes and nobody re-attaches → torn down
  m.nativeSocketClosed("sock2", (c: string) => void expired.push(c), 20);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(expired, [id]);
  assert.equal(m.nativeConnectionFor("sockX", "u2", "n_abc12345"), "native:u2:n_abc12345", "scoped per authenticated user");
});

test("native media: emergency LiveKit is joined by the app; page never captures the mic in native mode", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  const cmds: Record<string, unknown>[] = [];
  installWindow({ capabilities: ["calls", "nativeMedia"], nativeMedia: async (c: Record<string, unknown>) => { cmds.push(c); return true; }, msReply() {} });
  const s = new m.NativeMediaSession(fakeSocket() as never, { provider: "livekit", url: "wss://lk", token: "t", iceServers: [] } as never, {
    onRemoteTrack() {}, onState() {}, onLocalVideo() {}, callId: "c9",
  });
  await s.connect(false);
  assert.deepEqual(cmds[0], { op: "connectLiveKit", callId: "c9", url: "wss://lk", token: "t", iceServers: [], video: false, nativeVideo: false });
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.match(src, /media\.provider === "mediasoup" \|\| \(useNativeMedia\(/);
  assert.match(src, /provider === "livekit" && !useNativeMedia\(withVideo \|\| call\.video, this\.media\)/);
});

test("web/Safari: Answer tap binds the mic in the gesture and hands it to the UDP session", () => {
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.match(src, /this\.tapMic = navigator\.mediaDevices\s*\.getUserMedia/);
  assert.match(src, /preTrack: tapMic/);
  const ms = readFileSync(new URL("../../src/lib/calls/mediasoupSession.ts", import.meta.url), "utf8");
  assert.match(ms, /pre && pre\.readyState === "live"\s*\? pre/);
});

test("native media: Android app shim (OpenLoungeNativeMedia) is used; the Java interface alone is not", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  // Android Java bridge: capabilities() is a method returning a JSON string — must not count as native media
  const w = installWindow({ capabilities: () => '["calls","nativeMedia"]', postMessage() {} });
  assert.equal(m.useNativeMedia(false), false, "0.3.15 Android / no shim: WebView path");
  const cmds: unknown[] = [];
  const replies: unknown[] = [];
  w.OpenLoungeNativeMedia = {
    capabilities: ["nativeMedia"],
    nativeMedia: async (c: unknown) => { cmds.push(c); return { attached: false }; },
    msReply: (...a: unknown[]) => { replies.push(a); },
  };
  assert.equal(m.useNativeMedia(false), true, "Android 0.3.16 app: native audio");
  assert.equal(m.useNativeMedia(true), false, "video calls keep the WebView path");
  const sock = fakeSocket();
  const s = new m.NativeMediaSession(sock as never, { provider: "mediasoup", callId: "c1", iceServers: [] } as never, {
    onRemoteTrack() {}, onState() {}, onLocalVideo() {}, callId: "c1",
  });
  await s.connect(false);
  assert.deepEqual(cmds[0], { op: "connect", callId: "c1", iceServers: [], video: false, nativeVideo: false, tcpOnly: false });
  await (w.__olNativeMsReq as (id: string, ev: string, d: unknown) => void)("m1", "ms:join", { callId: "c1", nativeConn: "n_x" });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(replies[0], ["m1", true, { ok: true, echo: "ms:join" }]);
  s.close();
});

test("native media: Android 0.3.17 'wants LiveKit' signal hands over now; iOS/web keep the silent first-connect budget", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  installWindow({ capabilities: ["calls", "nativeMedia"], platform: "android", nativeMedia: async () => true, msReply() {} });
  assert.equal(m.nativeMediaIsAndroid(), true);
  const states: string[] = [];
  const wants: string[] = [];
  const s = new m.NativeMediaSession(fakeSocket() as never, { provider: "mediasoup", callId: "c1" } as never, {
    onRemoteTrack() {}, onState: (st) => states.push(st), onLocalVideo() {}, onWantsLiveKit: (r) => wants.push(r),
  });
  await s.connect(false);
  window.dispatchEvent(new CustomEvent("openlounge:native-media", { detail: { state: "failed", fallback: "livekit", reason: "produce: [json.exception.type_error.305]" } }));
  window.dispatchEvent(new CustomEvent("openlounge:native-media", { detail: { state: "failed" } }));
  assert.deepEqual(wants, ["produce: [json.exception.type_error.305]"]);
  assert.deepEqual(states, ["failed"], "a plain failed still maps to state");
  s.close();
  installWindow({ capabilities: ["calls", "nativeMedia"], nativeMedia: async () => true, msReply() {} });
  assert.equal(m.nativeMediaIsAndroid(), false, "iOS bridge has no platform");

  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.ok(src.includes("onWantsLiveKit: (reason) => { if (this.mediasoup === session) void this.nativeFailed(reason); }"));
  assert.ok(src.includes("else if (this.mediasoup instanceof NativeMediaSession && nativeMediaIsAndroid()) void this.androidNativeToWebView("));
  assert.ok(src.includes("if (nativeMediaIsAndroid()) return this.androidNativeToWebView(reason);"), "Android native failure -> WebView media");
  assert.ok(src.includes("else if (!recovering && !this.inFirstRetry) void this.retryFirstConnect("), "web/iOS keep the silent retry budget");
  assert.ok(src.includes('await this.lastResortLiveKit("native-ms-failed", reason);'));
});

function setUA(ua: string) {
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: ua }, configurable: true, writable: true });
}

test("Android baseline moat: WebView media by default for every build; native only with the server opt-in, build 34+, and a healthy device; a failure falls back and holds for 7 days", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  const prevNav = (globalThis as { navigator?: unknown }).navigator;
  try {
    m.resetAndroidNativeMedia();
    installWindow({ capabilities: ["calls", "nativeMedia"], platform: "android", nativeMedia: async () => true, msReply() {} });
    setUA("Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile OpenLounge/android/0.3.19(35) OpenLoungeAndroid/0.3.19");
    assert.equal(m.androidAppBuild(), 35);
    assert.equal(m.useNativeMedia(false), false, "0.3.19 (35) with no server opt-in: WebView baseline");
    m.noteAndroidNativeOptIn(false);
    assert.equal(m.useNativeMedia(false), false, "explicit server off: WebView baseline");
    m.noteAndroidNativeOptIn(true);
    assert.equal(m.useNativeMedia(false), true, "server opt-in + build 35: native");
    assert.equal(m.useNativeMedia(true), false, "video calls keep the WebView path");
    setUA("Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile OpenLounge/android/0.3.17(33) OpenLoungeAndroid/0.3.17");
    assert.equal(m.useNativeMedia(false), false, "build 33 stays on WebView even when opted in");
    setUA("Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile OpenLounge/android/0.3.19(35) OpenLoungeAndroid/0.3.19");
    m.disableAndroidNativeMedia("first connect budget");
    assert.equal(m.useNativeMedia(false), false, "after a native failure: WebView path");
    assert.equal(m.androidNativeDisabledReason(), "first connect budget");
    m.newAndroidPageSession();
    assert.equal(m.useNativeMedia(false), false, "device guard holds across page reloads");
    assert.equal(m.androidNativeHealthy(Date.now() + m.ANDROID_NATIVE_COOLDOWN_MS + 1000), true, "guard expires after 7 days");
    m.noteAndroidNativeOptIn(false);
    assert.equal(m.androidNativeOptedIn(), false, "server kill switch clears the opt-in on the next grant");
    installWindow({ capabilities: ["calls", "nativeMedia"], nativeMedia: async () => true, msReply() {} });
    assert.equal(m.useNativeMedia(false), true, "iOS is never affected by the Android switch");
    installWindow(null);
    assert.equal(m.useNativeMedia(false), false, "web unchanged");
  } finally {
    m.resetAndroidNativeMedia();
    Object.defineProperty(globalThis, "navigator", { value: prevNav, configurable: true, writable: true });
  }
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.ok(/set media\(m: CallMedia \| null\) \{[\s\S]{0,120}noteAndroidNativeOptIn\(!!m\.androidNative\)/.test(src), "every mediasoup grant refreshes the opt-in");
  const fb = src.slice(src.indexOf("private async androidNativeToWebView"), src.indexOf("private lifecycle:"));
  assert.ok(/disableAndroidNativeMedia\(reason\)[\s\S]*dropMediaForRejoin\(\)[\s\S]*this\.msEverConnected = null[\s\S]*await this\.connectMediasoup\(media, true\)/.test(fb), "same call reconnects over WebView media");
  assert.ok(fb.includes("this.nativeWebCall === callId"), "once per call");
});

test("server: CALL_ANDROID_NATIVE defaults OFF; only 'on' adds androidNative to mediasoup grants; LiveKit grants never carry it", async () => {
  const { androidNativeEnabled } = await import("../../server/calls/sfuSelect");
  assert.equal(androidNativeEnabled({}), false);
  assert.equal(androidNativeEnabled({ CALL_ANDROID_NATIVE: "off" }), false);
  assert.equal(androidNativeEnabled({ CALL_ANDROID_NATIVE: "true" }), false);
  assert.equal(androidNativeEnabled({ CALL_ANDROID_NATIVE: "on" }), true);
  const idx = readFileSync(new URL("../../server/calls/index.ts", import.meta.url), "utf8");
  assert.ok(idx.includes("...(androidNativeEnabled() ? { androidNative: true } : {})"));
  assert.equal((idx.match(/androidNative: true/g) ?? []).length, 1, "only the mediasoup grant");
});

test("baseline regression (a8a754e): Android WebView path keeps the 5 s first-connect budget from answer, mic handling, LiveKit pin", () => {
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.ok(src.includes("static FIRST_CONNECT_BUDGET_MS = 5_000;"));
  assert.ok(src.includes("Promise.race([session.connect(this.s.camOn), this.firstConnectBudget()])"));
  assert.ok(/while \(ringing\(\)\) await[\s\S]{0,80}this\.firstConnectT0 = Date\.now\(\)/.test(src));
  assert.ok(/: CallEngine\.FIRST_CONNECT_BUDGET_MS;/.test(src), "WebView session gets the unchanged 5 s base");
  assert.ok(src.includes("} else this.preMic = this.acquireMic();"), "WebView caller still captures the mic at dial (unchanged)");
});

test("Android app: WebView media path, caller budget from answer, LiveKit pinned; iOS native unchanged", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  installWindow({ capabilities: ["calls", "nativeMedia"], platform: "android", nativeMedia: async () => true, msReply() {} });
  assert.equal(m.useNativeMedia(false), false, "Android app without a 0.3.18+ UA uses the WebView path");
  installWindow({ capabilities: ["calls", "nativeMedia"], nativeMedia: async () => true, msReply() {} });
  assert.equal(m.useNativeMedia(false), true, "iOS app keeps native media");
  installWindow(null);
  assert.equal(m.useNativeMedia(false), false, "web unchanged");
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.ok(src.includes("Promise.race([session.connect(this.s.camOn), this.firstConnectBudget()])"));
  assert.ok(/while \(ringing\(\)\) await[\s\S]{0,80}this\.firstConnectT0 = Date\.now\(\)/.test(src), "caller budget starts at answer");
  assert.ok(!/shouldTryUdp\(now\)\) void this\.requestUdpRestore\(\)/.test(src), "no LiveKit → SFU flap-back");
});

test("d8d7eded: push-woken/resumed callee gets a 12 s first-connect grace from socket-back; native LiveKit last resort has its own 15 s budget", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.ok(src.includes("static WOKEN_GRACE_MS = 12_000;"));
  assert.ok(src.includes("static LIVEKIT_JOIN_BUDGET_MS = 15_000;"));
  assert.ok(src.includes('this.s.role !== "callee"'));
  assert.ok(src.includes("this.socketUpAt = Date.now();"));
  assert.ok(src.includes('media.provider === "livekit"\n        ? Promise.race'));
  assert.ok(src.includes('this.failUdpUnreachable("livekit-native"'));
  // the plain 5 s budget remains the default (web caller, non-woken callee)
  assert.ok(src.includes(": CallEngine.FIRST_CONNECT_BUDGET_MS;"));
  assert.ok(src.includes("return base;"));
});

test("3ae8ff34: floor 'tcp' verdict while the transport is still connected resumes the ladder instead of freezing at 16 kbps", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.ok(src.includes("void this.requestTcpFallback().finally(() => {"));
  assert.ok(src.includes("this.mediasoupConnected && !this.msRecovering && this.busy && !this.qualityTimer"));
  const { NetLadder, ADAPT, LADDER } = await import("../../src/lib/calls/netAdapt");
  const l = new NetLadder();
  l.reset(ADAPT.reconnectLevel);
  let up = 0;
  for (let i = 0; i < ADAPT.upAfter; i++) { const a = l.push({ lossPercent: 0, rttMs: 60, outKbps: 300, reasons: [] }); if (a.type === "step" && a.dir === "up") up++; }
  assert.equal(up, 1);
  assert.equal(LADDER[l.level].audioBps, 48_000);
});

test("protected: Android video path unchanged — video never takes native media in any opt-in/guard state; WebView video files identical to prod 087c96b", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  const prevNav = (globalThis as { navigator?: unknown }).navigator;
  try {
    m.resetAndroidNativeMedia();
    installWindow({ capabilities: ["calls", "nativeMedia"], platform: "android", nativeMedia: async () => true, msReply() {} });
    Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Linux; Android 14) OpenLounge/android/0.3.19(35)" }, configurable: true, writable: true });
    for (const opt of [false, true]) {
      m.noteAndroidNativeOptIn(opt);
      assert.equal(m.useNativeMedia(true), false, `video, opt-in=${opt}`);
    }
    m.disableAndroidNativeMedia("x");
    assert.equal(m.useNativeMedia(true), false, "video after a native failure");
  } finally {
    m.resetAndroidNativeMedia();
    Object.defineProperty(globalThis, "navigator", { value: prevNav, configurable: true, writable: true });
  }
  const { execSync } = await import("node:child_process");
  const changed = execSync("git diff --name-only 087c96b -- src/lib/calls/mediasoupSession.ts src/lib/calls/androidLifecycle.ts src/lib/calls/netAdapt.ts", { encoding: "utf8" }).trim();
  assert.equal(changed, "", "WebView media session / Android lifecycle / bandwidth ladder untouched");
});


test("iPhone paired-video path: one explicit msid, fenced page camera, deferred ringback and final WebView fallback", () => {
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  const bridge = readFileSync(new URL("../../src/lib/calls/nativeMediaSession.ts", import.meta.url), "utf8");
  assert.match(bridge, /connectInner\(withVideo: boolean\)/);
  assert.match(bridge, /streamId: this\.opts\.streamId/);
  assert.match(src, /iosNativeVideoOwnsCamera\(\)/);
  assert.match(src, /if \(this\.iosNativeVideoCaptureFenced \|\| this\.iosNativeVideoOwnsCamera\(\)\) return null;/);
  assert.match(src, /if \(!this\.mediasoup && \(this\.iosNativeVideoCaptureFenced \|\| this\.iosNativeVideoOwnsCamera\(\)\)\)/);
  assert.match(src, /iosNativeVideoToWebView[\s\S]*iosNativeVideo: false/);
  assert.match(src, /if \(this\.media\?\.iosNativeVideo\) this\.deferNativeConnect/);
  assert.match(bridge, /async refreshCameraQuality\(\) \{ return false; \}/);
  assert.doesNotMatch(bridge, /refresh: true/, "network adaptation must not restart a native iPhone camera");
});
