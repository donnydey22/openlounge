import {bridgeMode,wirePlatformCalls,attachPlatformCalls} from "./bridge/platform";
// Wires the one-PC P2P CallService + sealed rcRelay into WS, platform store and push.
import type { Conn, WsHub } from "../ws";
import { store } from "../store";
import { bg, push } from "../push";
import { log, metrics } from "../log";
import { callTelemetry, sanitizeSample } from "./telemetry";
import { CallService } from "./service";
import type { CallMediaBackend } from "./mediaBackend";
import { initVoip, voipService } from "./voip";
import { declineTokens } from "./declineToken";
import { mintTurnIceServers } from "../turnCredentials";
import { RtcSessionHub } from "./rtcSession";
import { RcRelay, PreKeyDirectory } from "./rcRelay";
import { filePreKeyStore } from "./preKeyFileStore";
import { p2pMedia, rtcIceConfig } from "./rtcIceConfig";
import { iosNativeVideoEnabled } from "./sfuSelect";

/** Call TURN logins (ICE relay transport only, Signal-style) live at most 10 minutes. Rejoins/call:get mint fresh ones. */
export const CALL_TURN_TTL_S = 600;

/** user -> last socket close (code / cause / liveness context): lets "call peer offline" say WHY a socket dropped */
const lastClose = new Map<string, Record<string, unknown>>();
/** call ids whose VoIP (CallKit) push already rang the callee's iPhone; bounded by a 2 min expiry */
const voipRang = new Set<string>();

type AckFn = (res: Record<string, unknown>) => void;
const noop: AckFn = () => {};

let svc: CallService | null = null;
let rtc: RtcSessionHub | null = null;
let rc: RcRelay | null = null;
export const rtcHub = () => rtc;
export const calls = () => svc;

/** WebSocket upgrade headers, unlike page request bodies, are set by the iOS wrapper itself. */
export function isIosNativeVideoWrapper(userAgent: unknown): boolean {
  const ua = typeof userAgent === "string" ? userAgent : "";
  return /\bOpenLounge\/ios\/[^\s(]+\(\d+\)/i.test(ua);
}

/** Same fields as the FCM call_incoming data message (NATIVE_SPEC.md §1). */
export function voipPayload(call: { id: string; callerId: string; video: boolean; expiresAt: number; caller: { name: string; photoUrl: string | null } }, declineToken: string) {
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
  if (bridgeMode()) { svc=null;rtc=null;rc=null;wirePlatformCalls(io);return null; }
  if (!voipService()) initVoip({ log: (msg, extra) => log.info(`[voip] ${msg}`, extra) });
  const p2pBackend: CallMediaBackend = {
    provider: "p2p",
    issue: async ({ callId, userId, ttlSec }) => p2pMedia(callId, userId, ttlSec),
    close: (callId) => { rtc?.end(callId); rc?.end(callId); },
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
    // RingRTC session model: the ONLY calling media path is P2P WebRTC (BSD M152 / browser) with E2E-sealed rc:msg
    // signaling (rcRelay) + OL ICE/TURN creds (rtcIceConfig). No mediasoup, no LiveKit, no in-call provider migration.
    selectMedia: () => p2pBackend,
    push: {
      // iPhone build 18+: CallKit via a PushKit VoIP push first; if any iPhone took it, skip the duplicate iOS alert
      incoming: (calleeId, call) =>
        bg(
          (async () => {
            // one single-use, call+callee-scoped token shared by both surfaces: Decline works even with an expired session
            const declineToken = declineTokens().mint(call.id, calleeId, call.expiresAt);
            const rang = await (voipService()?.ring(calleeId, voipPayload(call, declineToken), call.expiresAt) ?? Promise.resolve(0)).catch(() => 0);
            if (rang > 0) {
              voipRang.add(call.id);
              setTimeout(() => voipRang.delete(call.id), 120_000).unref?.();
            }
            await push()?.callIncoming(calleeId, call, { skipIos: rang > 0, declineToken });
          })(),
        ),
      // ring retry (service callRepushMs): FCM / web push / iOS alert only — never a second VoIP push
      repush: (calleeId, call) =>
        // CallKit already rang on iOS: a second iOS alert push is a duplicate ring (Oct 31, b22f5441) — Android/web only
        bg(push()?.callIncoming(calleeId, call, { skipIos: voipRang.has(call.id), declineToken: declineTokens().mint(call.id, calleeId, call.expiresAt) })),
      cancel: (calleeId, callId, reason) => { voipRang.delete(callId); return bg(push()?.callCancel(calleeId, callId, reason)); },
    },
    log: (msg, extra) => log.info(`[calls] ${msg}`, extra),
  });
  const cur = svc;
  metrics.gauge("calls_live", () => cur.stats().live);
  metrics.gauge("calls_accept_to_audio_p50_ms", () => cur.stats().acceptToAudio.p50 ?? 0);
  metrics.gauge("calls_quality_two_way_total", () => cur.stats().quality["two-way"]);
  metrics.gauge("calls_quality_one_way_total", () => cur.stats().quality["one-way"]);
  metrics.gauge("calls_quality_no_audio_total", () => cur.stats().quality["no-audio"]);
  metrics.gauge("calls_quality_no_data_total", () => cur.stats().quality["no-data"]);
  rc = new RcRelay({ call: (id) => svc?.rtcCall(id) ?? null, emitUser: (u, ev, data) => io.to(`user:${u}`).emit(ev, data) }, new PreKeyDirectory(process.env.RC_PREKEY_DIR ? filePreKeyStore(process.env.RC_PREKEY_DIR) : undefined));
  rtc = new RtcSessionHub({ call: (id) => svc?.rtcCall(id) ?? null, emitUser: (u, ev, data) => io.to(`user:${u}`).emit(ev, data) });
  return svc;
}

export function attachCallHandlers(socket: Conn, authed: (ack: AckFn | undefined, fn: (userId: string) => void) => void, iosNativeVideoWrapper = false) {
  if (bridgeMode()) return attachPlatformCalls(socket,authed);
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
    if (callUser) svc?.connClosed(socket.id, callUser);
  });
  socket.on("call:start", ({ peerId, video, nativeVideo, platform }: { peerId: string; video?: boolean; nativeVideo?: unknown; platform?: unknown }, ack: AckFn = noop) =>
    authed(ack, (uid) => void ((callUser = uid), s().start(uid, peerId, !!video, socket.id, nativeVideo === true && iosNativeVideoWrapper && iosNativeVideoEnabled(), platform)).then(ack, () => ack({ ok: false, error: "Couldn't start the call" }))),
  );
  // P2P calling signaling (offer/answer/candidates) + fresh short-lived OL ICE credentials.
  socket.on("rtc:signal", (d: unknown, ack: AckFn = noop) => authed(ack, (uid) => ack(rtc ? rtc.signal(uid, d) : { ok: false, error: "unknown_call" })));
  // RingRTC session model: E2E-sealed call messages + OLX3DH-v1 prekey directory (rcRelay.ts).
  socket.on("rc:msg", (d: unknown, ack: AckFn = noop) => authed(ack, (uid) => ack(rc ? rc.msg(uid, d) : { ok: false, error: "unknown_call" })));
  socket.on("rc:keys:publish", (d: unknown, ack: AckFn = noop) => authed(ack, (uid) => void (rc ? rc.keys.publish(uid, d) : Promise.resolve({ ok: false })).then(ack, () => ack({ ok: false }))));
  socket.on("rc:keys:fetch", (d: { userId?: unknown; callId?: unknown } = {}, ack: AckFn = noop) => authed(ack, (uid) => void (rc ? rc.fetchFor(uid, d) : Promise.resolve({ ok: false })).then(ack, () => ack({ ok: false }))));
  socket.on("rtc:iceConfig", ({ callId }: { callId?: unknown } = {}, ack: AckFn = noop) =>
    authed(ack, (uid) => {
      const c = typeof callId === "string" ? s().rtcCall(callId) : null;
      if (!c || (uid !== c.callerId && uid !== c.calleeId) || c.phase === "ended") return ack({ ok: false, error: "not_participant" });
      ack({ ok: true, config: rtcIceConfig(callId as string, uid) });
    }),
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
  // FX-081 per-stream telemetry (every 5 s per client): sanitized, bounded per call, one log line per sample
  socket.on("call:telemetry", (d: unknown, ack: AckFn = noop) =>
    authed(ack, (uid) => {
      const callId = typeof (d as { callId?: unknown })?.callId === "string" ? String((d as { callId: string }).callId).slice(0, 36) : "";
      const rows = sanitizeSample("client", uid.slice(0, 12), d);
      if (!callId || !rows.length) return ack({ ok: false });
      callTelemetry.add(callId, rows);
      log.info("[calls] telemetry", { callId, src: "client", user: uid.slice(0, 12), platform: rows[0].platform, net: rows[0].net, s: rows.map(({ src: _s, user: _u, t: _t, platform: _p, net: _n, ...r }) => r) });
      ack({ ok: true });
    }),
  );
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
      const iceServers = mintTurnIceServers(callId, uid, { ttlS: CALL_TURN_TTL_S }) ?? [];
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
}
