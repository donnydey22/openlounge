// Pure call-signaling state machine. Mirrors ChatSwap new_call / participant / reject / left / join / offer / answer / ice,
// with ChatSwap's flaws fixed: events go only to the two call participants (never a broadcast), TURN creds are
// short-lived HMAC (coturn use-auth-secret), relay order is UDP -> TCP -> TLS 443.
import crypto from "node:crypto";

export const RING_TIMEOUT_MS = 30_000;

export function iceConfig({ secret, userId, host = "turn.openlounge.app", ttlSec = 600, now = Date.now() }) {
  const username = `${Math.floor(now / 1000) + ttlSec}:${userId}`;
  const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
  return {
    ttlSec,
    // ChatSwap WebRtcBaseActivity.kt:329-345 parity: UNIFIED_PLAN, MAXBUNDLE, rtcpMux REQUIRE, ICE ALL, GATHER_CONTINUALLY
    policy: { sdpSemantics: "unified-plan", bundlePolicy: "max-bundle", rtcpMuxPolicy: "require", iceTransportPolicy: "all", continualGathering: true },
    iceServers: [
      { urls: [`stun:${host}:3478`] },
      { urls: [`turn:${host}:3478?transport=udp`], username, credential },
      { urls: [`turn:${host}:3478?transport=tcp`], username, credential },
      { urls: [`turns:${host}:443?transport=tcp`], username, credential },
    ],
  };
}

export function createSignal({ send, push = () => {}, online = () => true, setTimer = setTimeout, clearTimer = clearTimeout, ringMs = RING_TIMEOUT_MS }) {
  const calls = new Map(); // callId -> {id, caller, callee, kind, state, timer}
  const byUser = new Map(); // userId -> callId
  const peer = (c, u) => (c.caller === u ? c.callee : c.caller);
  const end = (c, reason, by) => {
    if (!calls.has(c.id)) return;
    clearTimer(c.timer);
    calls.delete(c.id);
    if (byUser.get(c.caller) === c.id) byUser.delete(c.caller);
    if (byUser.get(c.callee) === c.id) byUser.delete(c.callee);
    for (const u of [c.caller, c.callee]) send(u, { t: "call:ended", callId: c.id, reason, by });
  };
  const own = (u, callId) => { const c = calls.get(callId); return c && (c.caller === u || c.callee === u) ? c : null; };
  return {
    calls, byUser,
    handle(u, m) {
      switch (m?.t) {
        case "call:new": { // socketEvents.js:1468 new_call: busy check + ring + push
          if (!m.to || m.to === u) return { ok: false, error: "bad_target" };
          if (byUser.has(u)) return { ok: false, error: "busy_self" };
          if (byUser.has(m.to)) { send(u, { t: "call:busy", to: m.to }); return { ok: false, error: "busy" }; }
          const c = { id: crypto.randomUUID(), caller: u, callee: m.to, kind: m.kind === "audio" ? "audio" : "video", state: "ringing" };
          calls.set(c.id, c); byUser.set(u, c.id); byUser.set(m.to, c.id);
          c.timer = setTimer(() => end(c, "timeout"), ringMs);
          send(m.to, { t: "call:incoming", callId: c.id, from: u, kind: c.kind });
          if (!online(m.to)) push(m.to, { callId: c.id, from: u, kind: c.kind, ttlSec: Math.ceil(ringMs / 1000) });
          return { ok: true, callId: c.id };
        }
        case "call:accept": { const c = own(u, m.callId); if (!c || c.callee !== u || c.state !== "ringing") return { ok: false };
          clearTimer(c.timer); c.state = "live"; send(c.caller, { t: "call:accepted", callId: c.id }); return { ok: true }; }
        case "call:reject": { const c = own(u, m.callId); if (!c) return { ok: false }; end(c, "rejected", u); return { ok: true }; }
        case "call:leave": { const c = own(u, m.callId); if (!c) return { ok: false }; end(c, c.state === "ringing" && u === c.caller ? "cancelled" : "hangup", u); return { ok: true }; }
        case "offer": case "answer": case "ice": { // :1788-1830 relay, peer only
          const c = own(u, m.callId); if (!c) return { ok: false };
          send(peer(c, u), { t: m.t, callId: c.id, from: u, sdp: m.sdp, candidate: m.candidate }); return { ok: true }; }
        default: return { ok: false, error: "unknown" };
      }
    },
    disconnected(u) { const id = byUser.get(u); if (id) end(calls.get(id), "disconnected", u); },
  };
}
