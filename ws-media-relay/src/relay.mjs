// Browser WASM media path (PLAN §9/§13). Browsers cannot send UDP, so the WASM pjmedia stack sends each already-SRTP
// RTP/RTCP packet as one binary WebSocket frame. The relay is a dumb pipe: one UDP socket per WS, frames forwarded
// unchanged to the call's mediasoup PlainTransport (ip:port issued by the SFU), and UDP back to the WS. No decryption.
import dgram from "node:dgram";
import { WebSocketServer } from "ws";

export const MAX_PKT = 1500;

export function createRelay({ server, port, verify, resolveTarget, log = () => {} }) {
  const wss = new WebSocketServer(server ? { server, maxPayload: MAX_PKT } : { port, maxPayload: MAX_PKT });
  wss.on("connection", async (ws, req) => {
    const q = new URL(req.url, "http://x").searchParams;
    const uid = verify(q.get("token"));
    if (!uid) return ws.close(4001, "auth");
    const target = await resolveTarget({ userId: uid, callId: q.get("callId") });
    if (!target) return ws.close(4004, "no_call");
    const udp = dgram.createSocket(target.host.includes(":") ? "udp6" : "udp4");
    let open = true;
    const close = () => { if (!open) return; open = false; try { udp.close(); } catch {} };
    udp.on("message", (pkt, rinfo) => {
      if (rinfo.port !== target.port || ws.readyState !== 1) return; // only the SFU leg we were issued
      if (ws.bufferedAmount > 256 * 1024) return; // drop instead of building latency (media, not data)
      ws.send(pkt, { binary: true });
    });
    udp.on("error", () => ws.close(1011));
    ws.on("message", (data, isBinary) => {
      if (!isBinary || !open || data.length < 12 || data.length > MAX_PKT) return;
      udp.send(data, target.port, target.host);
    });
    ws.on("close", close); ws.on("error", close);
    log("relay_open", { callId: q.get("callId") });
  });
  return wss;
}
