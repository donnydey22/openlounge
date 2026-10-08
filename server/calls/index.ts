// Wires CallService into the realtime layer (WS handlers) + store + LiveKit + push.
import type { Conn, WsHub } from "../ws";
import { store } from "../store";
import { closeLiveKitRoom, createJoinToken, livekit } from "../livekit";
import { bg, push } from "../push";
import { log, metrics } from "../log";
import { CallService } from "./service";

type AckFn = (res: Record<string, unknown>) => void;
const noop: AckFn = () => {};

let svc: CallService | null = null;
export const calls = () => svc;

/** room id passed to createJoinToken / closeLiveKitRoom → LiveKit room "openlounge-call-<id>" */
const mediaRoom = (callId: string) => `call-${callId}`;

export function wireCalls(io: WsHub, isForeground: (userId: string) => boolean) {
  svc?.dispose();
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
    mintToken: (callId, userId, name) => (livekit.enabled ? createJoinToken({ roomId: mediaRoom(callId), userId, name, canPublish: true }) : Promise.resolve(null)),
    mediaUrl: () => (livekit.enabled ? livekit.url : null),
    closeMedia: (callId) => closeLiveKitRoom(mediaRoom(callId), 3000),
    push: {
      incoming: (calleeId, call) => bg(push()?.callIncoming(calleeId, call)),
      cancel: (calleeId, callId, reason) => bg(push()?.callCancel(calleeId, callId, reason)),
    },
    log: (msg, extra) => log.info(`[calls] ${msg}`, extra),
  });
  const cur = svc;
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
  socket.on("call:metric", ({ callId, acceptToAudioMs }: { callId: string; acceptToAudioMs: number }, ack: AckFn = noop) =>
    authed(ack, (uid) => ack(s().metric(callId, uid, acceptToAudioMs))),
  );
}
