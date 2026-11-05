// Browser WASM media path (PLAN §9/§13). Browsers cannot send UDP, so the WASM pjmedia stack sends each already-SRTP
// RTP/RTCP packet as one binary WebSocket frame. The relay is a dumb pipe: one UDP socket per caller leg, frames
// forwarded unchanged to the call's mediasoup PlainTransport (ip:port issued by the SFU), and UDP back to the WS.
// No decryption.
//
// Reconnect grace (tweb parity, Donny 10:16 PM): mediasoup's comedia PlainTransport locks onto the first source
// ip:port it sees and drops packets from any other tuple (mediasoup 3.29.0 worker/src/RTC/PlainTransport.cpp:1043-1088).
// So when a browser's WS drops, its UDP socket is kept alive for GRACE_MS, keyed by the token's user+call. A WS that
// reconnects with the same token inside the grace reattaches to the same socket, mediasoup keeps seeing the same
// tuple, and media resumes with no new server messages. GRACE_MS = 45 s = tweb's 1:1 hang-up window
// (tweb src/lib/calls/constants.ts:33 CALL_REQUEST_TIMEOUT, armed while reconnecting at callsController.ts:493-498).
import dgram from "node:dgram";
import { WebSocketServer } from "ws";

export const MAX_PKT = 1500;
export const GRACE_MS = 45_000;

export function createRelay({ server, port, verify, resolveTarget, log = () => {}, graceMs = GRACE_MS }) {
  const wss = new WebSocketServer(server ? { server, maxPayload: MAX_PKT } : { port, maxPayload: MAX_PKT });
  const legs = new Map(); // `${uid}|${callId}` -> { udp, target, ws, timer, open }
  wss.legs = legs;
  const closeLeg = (k, leg) => { if (!leg.open) return; leg.open = false; clearTimeout(leg.timer); if (legs.get(k) === leg) legs.delete(k); try { leg.udp.close(); } catch {} };
  wss.on("close", () => { for (const [k, l] of legs) closeLeg(k, l); });
  wss.on("connection", async (ws, req) => {
    const q = new URL(req.url, "http://x").searchParams;
    const uid = verify(q.get("token"));
    if (!uid) return ws.close(4001, "auth");
    const callId = q.get("callId");
    const k = `${uid}|${callId ?? ""}`;
    let leg = legs.get(k);
    if (leg?.open) {
      // reattach: same UDP socket -> same tuple at the SFU
      clearTimeout(leg.timer); leg.timer = null;
      if (leg.ws && leg.ws !== ws) try { leg.ws.close(4009, "replaced"); } catch {}
      leg.ws = ws;
      log("relay_reattach", { callId });
    } else {
      const target = await resolveTarget({ userId: uid, callId });
      if (!target) return ws.close(4004, "no_call");
      const udp = dgram.createSocket(target.host.includes(":") ? "udp6" : "udp4");
      leg = { udp, target, ws, timer: null, open: true };
      legs.set(k, leg);
      const l = leg;
      udp.on("message", (pkt, rinfo) => {
        const w = l.ws;
        if (rinfo.port !== l.target.port || !w || w.readyState !== 1) return; // only the SFU leg we were issued
        if (w.bufferedAmount > 256 * 1024) return; // drop instead of building latency (media, not data)
        w.send(pkt, { binary: true });
      });
      udp.on("error", () => { try { l.ws?.close(1011); } catch {} closeLeg(k, l); });
      log("relay_open", { callId });
    }
    const l = leg;
    ws.on("message", (data, isBinary) => {
      if (l.ws !== ws || !isBinary || !l.open || data.length < 12 || data.length > MAX_PKT) return;
      l.udp.send(data, l.target.port, l.target.host);
    });
    const detach = () => {
      if (l.ws !== ws || !l.open) return;
      l.ws = null;
      l.timer = setTimeout(() => closeLeg(k, l), graceMs);
      l.timer.unref?.();
      log("relay_detach", { callId, graceMs });
    };
    ws.on("close", detach); ws.on("error", detach);
  });
  return wss;
}

/** Target lookup from the gateway: GET <url>?callId&userId (bearer RELAY_SECRET) -> {ip,port} published by the SFU's
 *  plain:create (ms:gateway:plainTarget). Short retry because the browser may open the WS just before plain:create lands. */
export function gatewayTargetResolver({ url, secret, tries = 10, waitMs = 200, fetchImpl = fetch }) {
  return async ({ callId, userId }) => {
    for (let i = 0; i < tries; i++) {
      const u = new URL(url); u.searchParams.set("callId", callId ?? ""); u.searchParams.set("userId", userId);
      const r = await fetchImpl(u, { headers: { authorization: `Bearer ${secret}` } }).catch(() => null);
      if (r?.ok) { const j = await r.json(); if (j?.ip && Number.isInteger(j.port)) return { host: j.ip, port: j.port }; }
      await new Promise((res) => setTimeout(res, waitMs));
    }
    return null;
  };
}
