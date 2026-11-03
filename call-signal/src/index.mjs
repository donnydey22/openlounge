// WS server: auth = HMAC token minted by Open Lounge's calls service (`<userId>.<exp>.<sig>`, CALL_SIGNAL_SECRET).
// Separate port + systemd unit on the droplet; does not touch coturn (3478/443) or mediasoup (40443/8081).
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { createSignal, iceConfig } from "./core.mjs";

const PORT = Number(process.env.PORT || 8090);
const SIGNAL_SECRET = process.env.CALL_SIGNAL_SECRET;
const TURN_SECRET = process.env.TURN_SECRET;
if (!SIGNAL_SECRET || !TURN_SECRET) { console.error("missing CALL_SIGNAL_SECRET/TURN_SECRET"); process.exit(1); }

export function verify(token, now = Date.now()) {
  const [uid, exp, sig] = String(token || "").split(".");
  if (!uid || !exp || !sig || Number(exp) * 1000 < now) return null;
  const want = crypto.createHmac("sha256", SIGNAL_SECRET).update(`${uid}.${exp}`).digest("base64url");
  return want.length === sig.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig)) ? uid : null;
}

const sockets = new Map();
const signal = createSignal({
  send: (u, msg) => { for (const ws of sockets.get(u) ?? []) ws.send(JSON.stringify(msg)); },
  online: (u) => (sockets.get(u)?.size ?? 0) > 0,
  push: (u, p) => console.log(`[push] TODO wire FCM/VoIP for ${u} call ${p.callId}`),
});

// SFU PlainTransport tuples (ms:gateway:plainTarget), recorded by the gateway, read by ws-media-relay.
const RELAY_SECRET = process.env.RELAY_SECRET;
const plainTargets = new Map(); // `${callId}:${userId}` -> {ip,port,at}
const relayAuthed = (req) => !!RELAY_SECRET && (req.headers.authorization || "") === `Bearer ${RELAY_SECRET}`;
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/plain-target")) {
    if (!relayAuthed(req)) { res.statusCode = 401; return res.end(); }
    const q = new URL(req.url, "http://x").searchParams, k = `${q.get("callId")}:${q.get("userId")}`;
    if (req.method === "POST") { let b = ""; req.on("data", (d) => { b += d; if (b.length > 1024) req.destroy(); });
      return req.on("end", () => { try { const j = JSON.parse(b); if (j.ip && Number.isInteger(j.port)) plainTargets.set(`${j.callId}:${j.userId}`, { ip: j.ip, port: j.port, at: Date.now() }); res.end("ok"); } catch { res.statusCode = 400; res.end(); } }); }
    const t = plainTargets.get(k); if (!t) { res.statusCode = 404; return res.end(); }
    res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ ip: t.ip, port: t.port }));
  }
  const uid = verify((req.headers.authorization || "").replace(/^Bearer /, ""));
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/ice" && uid) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(iceConfig({ secret: TURN_SECRET, userId: uid, mode: u.searchParams.get("mode") === "sfu" ? "sfu" : "p2p" }))); }
  if (req.url === "/health") return res.end("ok");
  res.statusCode = 401; res.end();
});
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
wss.on("connection", (ws, req) => {
  const uid = verify(new URL(req.url, "http://x").searchParams.get("token"));
  if (!uid) return ws.close(4001, "auth");
  if (!sockets.has(uid)) sockets.set(uid, new Set());
  sockets.get(uid).add(ws);
  ws.on("message", (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } const r = signal.handle(uid, m); if (m.ack) ws.send(JSON.stringify({ t: "ack", ack: m.ack, ...r })); });
  ws.on("close", () => { for (const k of plainTargets.keys()) if (k.endsWith(`:${uid}`)) plainTargets.delete(k); const s = sockets.get(uid); s?.delete(ws); if (!s?.size) { sockets.delete(uid); signal.disconnected(uid); } });
});
server.listen(PORT, "127.0.0.1", () => console.log(`call-signal on 127.0.0.1:${PORT}`));
