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

const server = http.createServer((req, res) => {
  const uid = verify((req.headers.authorization || "").replace(/^Bearer /, ""));
  if (req.url === "/ice" && uid) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify(iceConfig({ secret: TURN_SECRET, userId: uid }))); }
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
  ws.on("close", () => { const s = sockets.get(uid); s?.delete(ws); if (!s?.size) { sockets.delete(uid); signal.disconnected(uid); } });
});
server.listen(PORT, "127.0.0.1", () => console.log(`call-signal on 127.0.0.1:${PORT}`));
