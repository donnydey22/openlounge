// Wires CallService into the realtime layer (WS handlers) + store + LiveKit + push.
import type { Conn, WsHub } from "../ws";
import { store } from "../store";
import { closeLiveKitRoom, createJoinToken, kickFromLiveKitRoom, livekit } from "../livekit";
import { onLiveKitEvent } from "../livekitWebhook";
import { bg, push } from "../push";
import { log, metrics } from "../log";
import { CallService } from "./service";
import { initVoip, voipService } from "./voip";
import { declineTokens } from "./declineToken";
import { mintTurnIceServers } from "../turnCredentials";

type AckFn = (res: Record<string, unknown>) => void;
const noop: AckFn = () => {};

let svc: CallService | null = null;
let unwatchMedia: (() => void) | null = null;
export const calls = () => svc;

/** room id passed to createJoinToken / closeLiveKitRoom → LiveKit room "openlounge-call-<id>" */
const mediaRoom = (callId: string) => `call-${callId}`;
const CALL_ROOM_RE = /^openlounge-call-([0-9a-f-]{36})$/;

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
  svc = new CallService({
    emitUser: (userId, ev, data) => io.to(`user:${userId}`).emit(ev, data),
    isConnected: (userId) => {
      for (const _ of io.members(`user:${userId}`)) return true;
      return false;
    },
    isForeground,
    peer: (id) => {
      const u = store.publicUser(id);
      return u ? { id: u.id, name: u.name, username: u.username, color: u.color, photoUrl: u.photoUrl ?? null } : null;
    },
    policy: (a, b) => store.callPolicy(a, b),
    inRoom: (id) => store.currentRoomOf(id) !== null,
    appendCallMessage: (meta, calleeId) => void store.appendCallMessage(meta, calleeId),
    mintToken: (callId, userId, name, ttlSec) =>
      livekit.enabled ? createJoinToken({ roomId: mediaRoom(callId), userId, name, canPublish: true, ttlSec }) : Promise.resolve(null),
    mediaUrl: () => (livekit.enabled ? livekit.url : null),
    turnIceServers: (callId, userId) => mintTurnIceServers(callId, userId),
    closeMedia: (callId) => closeLiveKitRoom(mediaRoom(callId), 3000),
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
  return svc;
}

/** Per-connection handlers. `authed` is realtime.ts's guard (acks "Not signed in"). */
export function attachCallHandlers(socket: Conn, authed: (ack: AckFn | undefined, fn: (userId: string) => void) => void) {
  const s = () => svc!;
  socket.on("call:start", ({ peerId, video }: { peerId: string; video?: boolean }, ack: AckFn = noop) =>
    authed(ack, (uid) => void s().start(uid, peerId, !!video).then(ack, () => ack({ ok: false, error: "Couldn't start the call" }))),
  );
  socket.on("call:ack", ({ callId }: { callId: string }, ack: AckFn = noop) => authed(ack, (uid) => ack(s().ack(callId, uid))));
  socket.on("call:accept", ({ callId }: { callId: string }, ack: AckFn = noop) =>
    authed(ack, (uid) => void s().accept(callId, uid).then(ack, () => ack({ ok: false, error: "Couldn't answer" }))),
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
  socket.on("call:get", ({ callId }: { callId: string }, ack: AckFn = noop) =>
    authed(ack, (uid) => void s().get_(callId, uid).then(ack, () => ack({ ok: false, error: "Unavailable" }))),
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
