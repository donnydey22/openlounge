// Wires CallService into the realtime layer (WS handlers) + store + LiveKit + push.
import type { Conn, WsHub } from "../ws";
import { store } from "../store";
import { closeLiveKitRoom, createJoinToken, kickFromLiveKitRoom, livekit } from "../livekit";
import { onLiveKitEvent } from "../livekitWebhook";
import { bg, push } from "../push";
import { log, metrics } from "../log";
import { CallService } from "./service";
import type { CallMediaBackend } from "./mediaBackend";
import { initVoip, voipService } from "./voip";
import { declineTokens } from "./declineToken";
import { mintTurnIceServers } from "../turnCredentials";
import { randomUUID } from "node:crypto";
import { mintMediasoupAdmission } from "../mediasoup/admission";
import { MediasoupGateway } from "../mediasoup/gateway";
import { androidNativeEnabled, iosMicReacquireEnabled, iosNativeVideoEnabled, liveKitAllowed, sfuSelected } from "./sfuSelect";

/** Mediasoup call TURN logins live at most 10 minutes (Donny, Oct 24). Rejoins/call:get mint fresh ones. */
export const MEDIASOUP_TURN_TTL_S = 600;

/** Relay fallback for mediasoup calls, every lane (iPhone native, browser/Keiko) (Donny, Oct 24 5:28 AM): direct UDP to
 *  the SFU on 165.232.137.71 always comes first (it announces UDP host candidates; ICE ranks host above relay), then
 *  TURN over TCP 3478, then TURNS 443 on turn.openlounge.app. TURN-over-UDP is not offered. */
export function mediasoupTurnUrls(urls: readonly string[]): string[] {
  const udp = urls.filter((u) => u.startsWith("turn:") && !/transport=tcp/.test(u));
  const tcp = urls.filter((u) => u.startsWith("turn:") && /transport=tcp/.test(u));
  const tls = urls.filter((u) => u.startsWith("turns:"));
  // Oct 23 order kept (Donny 5:41 AM): direct UDP first (SFU candidates), then TURN UDP 3478, TCP 3478, TURNS 443
  return [...udp, ...tcp, ...tls];
}
import { isBenignMediaFailure } from "./mediaLog";

/** user -> last socket close (code / cause / liveness context): lets "call peer offline" say WHY a socket dropped */
const lastClose = new Map<string, Record<string, unknown>>();

type AckFn = (res: Record<string, unknown>) => void;
const noop: AckFn = () => {};

let svc: CallService | null = null;
let unwatchMedia: (() => void) | null = null;
let gateway: MediasoupGateway | null = null;
export const calls = () => svc;
const mediaGateway = () => (gateway ??= new MediasoupGateway());

/** room id passed to createJoinToken / closeLiveKitRoom → LiveKit room "openlounge-call-<id>" */
const mediaRoom = (callId: string) => `call-${callId}`;
const CALL_ROOM_RE = /^openlounge-call-([0-9a-f-]{36})$/;
/** WebSocket upgrade headers, unlike page request bodies, are set by the iOS wrapper itself. */
export function isIosNativeVideoWrapper(userAgent: unknown): boolean {
  const ua = typeof userAgent === "string" ? userAgent : "";
  return /\bOpenLounge\/ios\/[^\s(]+\(\d+\)/i.test(ua);
}

/** Same fields as the FCM call_incoming data message (NATIVE_SPEC.md §1). */
function voipPayload(call: { id: string; callerId: string; video: boolean; expiresAt: number; caller: { name: string; photoUrl: string | null } }, declineToken: string) {
  return {
    type: "call_incoming",
    callId: call.id,
    callerId: call.callerId,
    callerName: call.caller.name,
    callerPhoto: call.caller.photoUrl?.startsWith("http") ? call.caller.photoUrl : "",
    video: call.video ? "1" : "0",
    expiresAt: String(call.expiresAt),
    url: `/call/${call.id}`,
    declineToken, // session-less Decline from CallKit (server/calls/declineToken.ts)
  };
}

export function wireCalls(io: WsHub, isForeground: (userId: string) => boolean) {
  svc?.dispose();
  if (!voipService()) initVoip({ log: (msg, extra) => log.info(`[voip] ${msg}`, extra) });
  const gw = mediaGateway();
  // native-media connections (iOS app owns the SFU peer) are delivered to whichever page socket currently relays them
  gw.setNotifier(({ connectionId, event, data }) => io.get(nativeConns.get(connectionId)?.socketId ?? connectionId)?.emit(event, data));
  const liveKitBackend = (): CallMediaBackend | null => {
    if (!livekit.enabled) return null;
    return {
      provider: "livekit",
      issue: async ({ callId, userId, name, ttlSec }) => {
        const token = await createJoinToken({ roomId: mediaRoom(callId), userId, name, canPublish: true, ttlSec });
        const iceServers = mintTurnIceServers(callId, userId);
        return { provider: "livekit", url: livekit.url, token, expiresAt: Math.floor(Date.now() / 1000) + ttlSec, ...(iceServers ? { iceServers } : {}) };
      },
      close: (callId) => closeLiveKitRoom(mediaRoom(callId), 3000),
    };
  };
  const mediasoupBackend = (participants?: { callerId: string; calleeId: string; video?: boolean; iosNativeVideo?: boolean }): CallMediaBackend | null => {
    // The gateway must be connected before a new call ever selects UDP. If the SFU is unavailable, the unchanged
    // LiveKit/TCP call path is selected instead; no user action and no in-call backend choice is required.
    if (!sfuSelected(participants) || !gw.connected) return null;
    // call:start already made the server-authoritative iOS-wrapper decision; only that one-call grant
    // reaches the caller's direct-SFU credential, while all other endpoints remain on their established path.
    const iosNativeVideo = participants?.video === true && participants.iosNativeVideo === true;
    return {
      provider: "mediasoup",
      issue: async ({ callId, userId, ttlSec }) => {
        const token = mintMediasoupAdmission({ callId, userId, nonce: randomUUID(), ttlSec });
        // TLS fallback path: TURN-over-TLS on 443 (turns:) relaying to this same SFU. ICE ranks relay candidates
        // last, so direct UDP stays first, then direct ICE-TCP 40443, then TURNS/443 only on networks that allow
        // nothing but TLS:443. Only the turns: URL is offered here to avoid extra UDP/TCP TURN allocations.
        // Path order (Donny, Oct 17): direct UDP to the SFU first; our own TURN relay (turn.openlounge.app, TLS 443,
        // short-lived credentials) to the SAME SFU only when UDP can't connect — ICE ranks relay candidates last, so
        // normal networks never use it. The SFU's ICE-TCP 40443 candidate is not offered (udpOnlyResult).
        // UDP first, always (Donny, Oct 23): also offer TURN over UDP 3478 — a network that blocks the SFU's UDP port
        // range but allows UDP/3478 (common on hotel/corporate Wi-Fi) then stays on UDP via our relay instead of
        // dropping to TLS:443 (TCP head-of-line blocking = choppy audio on loss). ICE ranks relay-UDP above relay-TLS,
        // and both below direct UDP. turn:…?transport=tcp adds nothing over TLS:443 and is still not offered.
        const turns = mintTurnIceServers(callId, userId, { ttlS: MEDIASOUP_TURN_TTL_S })?.map((s) => ({ ...s, urls: mediasoupTurnUrls(s.urls) })).filter((s) => s.urls.length);
        return token ? { provider: "mediasoup", url: "broker", token, callId, expiresAt: Math.floor(Date.now() / 1000) + ttlSec, ...(turns?.length ? { iceServers: turns } : {}), ...(androidNativeEnabled() ? { androidNative: true } : {}), ...(iosMicReacquireEnabled() ? { iosMicReacquire: true } : {}), ...(iosNativeVideo && userId === participants?.callerId ? { iosNativeVideo: true } : {}) } : null;
      },
      relay: (input) => gw.request(input),
      close: (callId) => gw.closeCall(callId),
    };
  };
  svc = new CallService({
    lastCloseOf: (userId) => lastClose.get(userId) ?? null,
    emitUser: (userId, ev, data) => io.to(`user:${userId}`).emit(ev, data),
    isConnected: (userId) => {
      for (const _ of io.members(`user:${userId}`)) return true;
      return false;
    },
    isForeground,
    connCount: (userId) => {
      let n = 0;
      for (const _ of io.members(`user:${userId}`)) n++;
      return n;
    },
    peer: (id) => {
      const u = store.publicUser(id);
      return u ? { id: u.id, name: u.name, username: u.username, color: u.color, photoUrl: u.photoUrl ?? null } : null;
    },
    policy: (a, b) => store.callPolicy(a, b),
    inRoom: (id) => store.currentRoomOf(id) !== null,
    appendCallMessage: (meta, calleeId) => void store.appendCallMessage(meta, calleeId),
    selectMedia: (participants) => mediasoupBackend(participants) ?? (liveKitAllowed() ? liveKitBackend() : null),
    liveKitFallback: () => (liveKitAllowed() ? liveKitBackend() : null),
    push: {
      // iPhone build 18+: CallKit via a PushKit VoIP push first; if any iPhone took it, skip the duplicate iOS alert
      incoming: (calleeId, call) =>
        bg(
          (async () => {
            // one single-use, call+callee-scoped token shared by both surfaces: Decline works even with an expired session
            const declineToken = declineTokens().mint(call.id, calleeId, call.expiresAt);
            const rang = await (voipService()?.ring(calleeId, voipPayload(call, declineToken), call.expiresAt) ?? Promise.resolve(0)).catch(() => 0);
            await push()?.callIncoming(calleeId, call, { skipIos: rang > 0, declineToken });
          })(),
        ),
      // ring retry (service callRepushMs): FCM / web push / iOS alert only — never a second VoIP push
      repush: (calleeId, call) =>
        bg(push()?.callIncoming(calleeId, call, { declineToken: declineTokens().mint(call.id, calleeId, call.expiresAt) })),
      cancel: (calleeId, callId, reason) => bg(push()?.callCancel(calleeId, callId, reason)),
    },
    log: (msg, extra) => log.info(`[calls] ${msg}`, extra),
  });
  const cur = svc;
  // The call's media credential dies with the call: anyone joining an ENDED call's LiveKit room (e.g. with a token
  // LiveKit refreshed for them during the call, valid ~10 min) is removed and the room closed. Unknown calls (app
  // server restarted mid-call) are left alone — those calls end through the clients' own call:get.
  unwatchMedia?.();
  unwatchMedia = onLiveKitEvent((ev) => {
    if (ev.event !== "participant_joined" || svc !== cur) return;
    const m = CALL_ROOM_RE.exec(ev.room?.name ?? "");
    const who = ev.participant?.identity;
    if (!m || !who) return;
    if (cur.mediaAllowed(m[1], who) === false) {
      metrics.inc("calls_media_kicked_total");
      log.warn("[calls] join into an ended call's media room — removed", { callId: m[1] });
      return kickFromLiveKitRoom(mediaRoom(m[1]), who);
    }
  });
  metrics.gauge("calls_live", () => cur.stats().live);
  metrics.gauge("calls_accept_to_audio_p50_ms", () => cur.stats().acceptToAudio.p50 ?? 0);
  metrics.gauge("calls_quality_two_way_total", () => cur.stats().quality["two-way"]);
  metrics.gauge("calls_quality_one_way_total", () => cur.stats().quality["one-way"]);
  metrics.gauge("calls_quality_no_audio_total", () => cur.stats().quality["no-audio"]);
  metrics.gauge("calls_quality_no_data_total", () => cur.stats().quality["no-data"]);
  return svc;
}

/**
 * iOS native call media: the app's SFU peer outlives the WebView page that relays its signaling. Its connection id is
 * `native:<userId>:<nativeConn>` (stable across page reloads) instead of the socket id. When the relaying socket closes
 * the peer is kept for NATIVE_REATTACH_MS so a reloaded page re-attaches; otherwise it is torn down as before.
 */
export const NATIVE_REATTACH_MS = 45_000;
const NATIVE_CONN = /^n_[A-Za-z0-9]{6,40}$/;
const nativeConns = new Map<string, { userId: string; socketId: string; timer: NodeJS.Timeout | null }>();

/** resolve the SFU connection id for a relayed ms:* request (exported for tests) */
/** UDP-only media (Donny, Oct 17): strip the SFU's ICE-TCP (40443) candidates from transport:create for web AND native
 *  clients, so ICE can only use UDP to the main SFU. Reversible here without touching the SFU's config. */
export function udpOnlyResult(method: string, value: unknown): unknown {
  if (method !== "transport:create" || !value || typeof value !== "object") return value;
  const v = value as { transport?: { iceCandidates?: Array<{ protocol?: string }> } };
  const c = v.transport?.iceCandidates;
  if (!Array.isArray(c)) return value;
  return { ...v, transport: { ...v.transport, iceCandidates: c.filter((x) => String(x?.protocol ?? "udp").toLowerCase() === "udp") } };
}

export function nativeConnectionFor(socketId: string, userId: string, nativeConn: unknown): string | null {
  if (nativeConn === undefined) return socketId;
  if (typeof nativeConn !== "string" || !NATIVE_CONN.test(nativeConn)) return null;
  const id = `native:${userId}:${nativeConn}`;
  const cur = nativeConns.get(id);
  if (cur && cur.userId !== userId) return null;
  if (cur?.timer) clearTimeout(cur.timer);
  nativeConns.set(id, { userId, socketId, timer: null });
  return id;
}

/** the relaying socket closed: keep native peers it carried for a re-attach window, then clean up */
export function nativeSocketClosed(socketId: string, onExpire: (connectionId: string, userId: string) => void, ms = NATIVE_REATTACH_MS) {
  for (const [id, e] of nativeConns) {
    if (e.socketId !== socketId || e.timer) continue;
    e.timer = setTimeout(() => {
      const cur = nativeConns.get(id);
      if (cur !== e || cur.socketId !== socketId) return; // re-attached from a new page meanwhile
      nativeConns.delete(id);
      onExpire(id, e.userId);
    }, ms);
    e.timer.unref?.();
  }
}

export function nativeConnLeft(connectionId: string) {
  const e = nativeConns.get(connectionId);
  if (e?.timer) clearTimeout(e.timer);
  nativeConns.delete(connectionId);
}

/** Per-connection handlers. `authed` is realtime.ts's guard (acks "Not signed in"). */
export function attachCallHandlers(socket: Conn, authed: (ack: AckFn | undefined, fn: (userId: string) => void) => void, iosNativeVideoWrapper = false) {
  const s = () => svc!;
  const endedResent = new Set<string>(); // call ids whose ended state this socket was re-sent (call:diag)
  // A direct-media session is scoped to this exact browser WebSocket. The gateway relays this cleanup only after
  // normal app-side socket teardown; browser code cannot address another connection id.
  // The user this socket made call requests as: on close it leaves whatever call it was in (stale re-dial detection).
  let callUser: string | null = null;
  socket.onClose(() => {
    const info = socket.closeInfo;
    const uid = callUser ?? ([...socket.rooms].find((r) => r.startsWith("user:"))?.slice(5) ?? null);
    if (uid && info) {
      lastClose.set(uid, { closeCode: info.code, closeReason: info.reason, closeCause: info.cause, closeHidden: info.hidden, closeMissedPongs: info.missed, socketAgeMs: info.ageMs, socketIdleMs: info.idleMs, closedAt: Date.now() });
      const live = svc?.liveCallOf(uid);
      if (live) log.info("[calls] socket closed during call", { callId: live.id, userId: uid, phase: live.phase, ...info });
    }
    mediaGateway().closeConnection(socket.id);
    if (callUser) svc?.connClosed(socket.id, callUser);
    nativeSocketClosed(socket.id, (connectionId, userId) => {
      mediaGateway().closeConnection(connectionId);
      svc?.connClosed(connectionId, userId);
    });
  });
  // This is the sole gateway authentication route. It is intentionally outside `authed`: the SFU has no user session,
  // but must prove knowledge of a server-only secret before it can receive any brokered media command.
  socket.on("ms:gateway:hello", ({ secret }: { secret?: unknown }, ack: AckFn = noop) => ack(mediaGateway().attach(socket, secret)));
  socket.on("ms:gateway:response", (data: unknown, ack: AckFn = noop) => ack(mediaGateway().handleResponse(socket, data)));
  socket.on("ms:gateway:notice", (data: unknown, ack: AckFn = noop) => ack(mediaGateway().handleNotice(socket, data)));
  socket.on("call:start", ({ peerId, video, nativeVideo }: { peerId: string; video?: boolean; nativeVideo?: unknown }, ack: AckFn = noop) =>
    authed(ack, (uid) => void ((callUser = uid), s().start(uid, peerId, !!video, socket.id, nativeVideo === true && iosNativeVideoWrapper && iosNativeVideoEnabled())).then(ack, () => ack({ ok: false, error: "Couldn't start the call" }))),
  );
  socket.on("call:ack", ({ callId }: { callId: string }, ack: AckFn = noop) => authed(ack, (uid) => ack(s().ack(callId, uid))));
  socket.on("call:accept", ({ callId, platform }: { callId: string; platform?: unknown }, ack: AckFn = noop) =>
    authed(ack, (uid) => void ((callUser = uid), s().accept(callId, uid, socket.id, platform)).then(ack, () => ack({ ok: false, error: "Couldn't answer" }))),
  );
  socket.on("call:decline", ({ callId, message }: { callId: string; message?: string }, ack: AckFn = noop) =>
    authed(ack, (uid) => {
      const r = s().decline(callId, uid);
      // quick reply from the ring screen ("Can't talk now…") goes into the chat as a normal message
      if (r.ok && typeof message === "string" && message.trim() && "call" in r && r.call) store.sendDm(uid, r.call.callerId, message.trim().slice(0, 500));
      ack(r);
    }),
  );
  socket.on("call:hangup", ({ callId }: { callId: string }, ack: AckFn = noop) => authed(ack, (uid) => ack(s().hangup(callId, uid))));
  socket.on("call:video", ({ callId, on }: { callId: string; on: boolean }, ack: AckFn = noop) => authed(ack, (uid) => ack(s().setVideo(callId, uid, !!on))));
  // client call diagnostics (connect failure reasons, recovery, ladder steps): log only, never affects the call
  socket.on("call:diag", (d: { callId?: unknown; ev?: unknown; [k: string]: unknown }, ack: AckFn = noop) =>
    authed(ack, (uid) => {
      const str = (x: unknown, n = 160) => (typeof x === "string" || typeof x === "number" || typeof x === "boolean" ? String(x).slice(0, n) : undefined);
      const extra: Record<string, string> = {};
      for (const [k, v] of Object.entries(d ?? {}).slice(0, 12)) if (k !== "callId" && k !== "ev") { const sv = str(v); if (sv !== undefined) extra[k.slice(0, 24)] = sv; }
      log.info("[calls] client diag", { callId: str(d?.callId, 36), user: uid.slice(0, 12), ev: str(d?.ev, 40), ...extra });
      if (d?.ev === "audio-levels") s().qualitySample(d?.callId, uid, d as Record<string, unknown>); // server-side quality (service.ts)
      // A client still reporting on a call the server already ended (d8d7eded: the iPhone kept "connecting" 9 s past
      // the end and missed the next call 51c135b3) gets the ended state again, once per call per socket.
      const ended = s().endedFor(d?.callId, uid);
      if (ended && !endedResent.has(ended.id)) {
        endedResent.add(ended.id);
        log.info("[calls] call ended resent", { callId: ended.id, user: uid.slice(0, 12), ev: str(d?.ev, 40) });
        socket.emit("call:state", { call: ended });
      }
      ack({ ok: true });
    }),
  );
  socket.on("call:get", ({ callId }: { callId: string }, ack: AckFn = noop) =>
    authed(ack, (uid) => void ((callUser = uid), s().get_(callId, uid, socket.id)).then(ack, () => ack({ ok: false, error: "Unavailable" }))),
  );
  // Mid-call relay login refresh (Donny, Oct 24 2026): a fresh 10-min TURN login for a live call this user is in, so a
  // relayed call never outlives its login (coturn re-checks expiry on every allocation Refresh). Nothing else changes.
  socket.on("call:turnRefresh", ({ callId }: { callId?: unknown } = {}, ack: AckFn = noop) =>
    authed(ack, (uid) => {
      const live = s().liveCallOf(uid);
      if (!live || typeof callId !== "string" || live.id !== callId) return ack({ ok: false, error: "No live call" });
      const iceServers = mintTurnIceServers(callId, uid, { ttlS: MEDIASOUP_TURN_TTL_S })?.map((x) => ({ ...x, urls: mediasoupTurnUrls(x.urls) })).filter((x) => x.urls.length) ?? [];
      ack({ ok: true, iceServers });
    }),
  );
  socket.on("call:current", (_: unknown, ack: AckFn = noop) => authed(ack, (uid) => ack({ ok: true, call: s().liveCallOf(uid) })));
  socket.on("call:history", ({ before }: { before?: number }, ack: AckFn = noop) =>
    authed(ack, (uid) => {
      const h = store.callHistory(uid, before);
      const peers: Record<string, unknown> = {};
      for (const m of h.calls) {
        const pid = m.fromId === uid ? m.toId : m.fromId;
        if (!(pid in peers)) peers[pid] = store.publicUser(pid);
      }
      ack({ ok: true, ...h, peers });
    }),
  );
  socket.on("call:metric", ({ callId, acceptToAudioMs }: { callId: string; acceptToAudioMs: number }, ack: AckFn = noop) =>
    authed(ack, (uid) => ack(s().metric(callId, uid, acceptToAudioMs))),
  );
  socket.on("call:mediaFallback", ({ callId }: { callId: string }, ack: AckFn = noop) =>
    authed(ack, (uid) => void s().fallbackMedia(callId, uid).then(ack, () => ack({ ok: false, error: "TCP fallback failed" }))),
  );
  socket.on("call:mediaRestore", ({ callId }: { callId: string }, ack: AckFn = noop) =>
    authed(ack, (uid) => void s().restoreMedia(callId, uid).then(ack, () => ack({ ok: false, error: "UDP restore failed" }))),
  );
  const relay = (method: string) => (input: { callId?: string; [key: string]: unknown }, ack: AckFn = noop) =>
    authed(ack, (uid) => {
      const { callId, nativeConn, ...payload } = input ?? {};
      if (typeof callId !== "string") return ack({ ok: false, error: "callId required" });
      const connectionId = nativeConnectionFor(socket.id, uid, nativeConn);
      if (!connectionId) return ack({ ok: false, error: "bad native connection" });
      callUser = uid;
      if (method === "leave" && connectionId !== socket.id) nativeConnLeft(connectionId);
      // Leaving a call that already ended is idempotent: the call's media was closed by finish(). Ack ok instead of
      // logging a spurious "media request failed" (seen after every normal hangup).
      // (No connection teardown here: the same socket may already be in the next call.)
      if (method === "leave" && s().leaveIsNoop(callId, uid)) return ack({ ok: true, alreadyLeft: true });
      void s()
        .mediaRequest(callId, uid, connectionId, method, payload)
        .then((r) => {
          if (!r.ok) {
            if (isBenignMediaFailure(method, (r as { error?: unknown }).error)) {
              log.info("[calls] media leave after call end", { callId: callId.slice(0, 36), native: connectionId !== socket.id });
              return ack(r);
            }
            // failure-reason telemetry: which SFU step refused this device (first-connect failures were invisible)
            log.warn("[calls] media request failed", { callId: callId.slice(0, 36), method, native: connectionId !== socket.id, error: String((r as { error?: unknown }).error ?? "").slice(0, 160) });
            return ack(r);
          }
          const value = udpOnlyResult(method, r.result);
          ack(value && typeof value === "object" && !Array.isArray(value) ? { ok: true, ...(value as Record<string, unknown>) } : { ok: true, result: value });
        })
        .catch((e: unknown) => {
          log.warn("[calls] media request threw", { callId: callId.slice(0, 36), method, native: connectionId !== socket.id, error: String((e as Error)?.message ?? e).slice(0, 160) });
          ack({ ok: false, error: "UDP media unavailable" });
        });
    });
  socket.on("ms:join", relay("join"));
  socket.on("ms:leave", relay("leave"));
  socket.on("ms:transport:create", relay("transport:create"));
  socket.on("ms:transport:connect", relay("transport:connect"));
  socket.on("ms:transport:restartIce", relay("transport:restartIce"));
  socket.on("ms:produce", relay("produce"));
  socket.on("ms:consume", relay("consume"));
  socket.on("ms:consumer:resume", relay("consumer:resume"));
}
