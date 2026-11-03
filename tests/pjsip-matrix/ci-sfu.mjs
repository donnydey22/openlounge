// CI-only stack for the must-pass matrix (never deployed): real mediasoup worker + the production plain.mjs handler,
// call-signal core over WS (same protocol as phones), ws-media-relay resolving targets from the /plain-target gateway
// endpoint, and a static server for the WASM browser client. Loopback only.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { handlePlainRpc } from "../../media-sfu/src/plain.mjs";
import { createSignal } from "../../call-signal/src/core.mjs";
import { createRelay, gatewayTargetResolver } from "../../ws-media-relay/src/relay.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const req = createRequire(path.join(ROOT, "media-sfu/package.json"));
const mediasoup = req("mediasoup");
const TYPES = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm" };

export async function startCiSfu({ httpPort = 0, relayPort = 0 } = {}) {
  const worker = await mediasoup.createWorker({ logLevel: "warn", rtcMinPort: 40000, rtcMaxPort: 40200 });
  const router = await worker.createRouter({ mediaCodecs: [
    { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
    { kind: "video", mimeType: "video/H264", clockRate: 90000, parameters: { "packetization-mode": 1, "profile-level-id": "42e01f", "level-asymmetry-allowed": 1 } } ] });
  const sessions = new Map(); const targets = new Map(); const RELAY_SECRET = "ci";
  const sess = (callId, userId) => { const k = `${callId}:${userId}`; if (!sessions.has(k)) sessions.set(k, { callId, userId, transports: new Map(), producers: new Map(), consumers: new Map() }); return sessions.get(k); };
  const closeSess = (k) => { const s = sessions.get(k); if (!s) return; for (const m of [s.consumers, s.producers, s.transports]) for (const x of m.values()) x.close(); sessions.delete(k); targets.delete(k); };
  const sockets = new Map();
  const signal = createSignal({ send: (u, m) => sockets.get(u)?.send(JSON.stringify(m)) });
  const body = (r) => new Promise((ok) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => ok(b ? JSON.parse(b) : {})); });
  const server = http.createServer(async (q, r) => {
    const u = new URL(q.url, "http://x");
    try {
      if (u.pathname === "/rpc" && q.method === "POST") { const { callId, userId, method, payload } = await body(q);
        if (method === "plain:close") { closeSess(`${callId}:${userId}`); return r.end("{}"); }
        const out = await handlePlainRpc({ method, payload, s: sess(callId, userId), router, peers: sessions.values(), bindIp: "127.0.0.1", emitTarget: (t) => targets.set(`${t.callId}:${t.userId}`, t) });
        r.setHeader("content-type", "application/json"); return r.end(JSON.stringify(out)); }
      if (u.pathname === "/plain-target") { if (q.headers.authorization !== `Bearer ${RELAY_SECRET}`) { r.statusCode = 401; return r.end(); }
        const t = targets.get(`${u.searchParams.get("callId")}:${u.searchParams.get("userId")}`); if (!t) { r.statusCode = 404; return r.end(); } return r.end(JSON.stringify(t)); }
      if (u.pathname === "/stats") { let tr = 0; for (const s of sessions.values()) tr += s.transports.size; return r.end(JSON.stringify({ sessions: sessions.size, transports: tr, calls: signal.calls.size })); }
      const f = path.join(ROOT, path.normalize(u.pathname)); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.statusCode = 404; return r.end(); }
      r.setHeader("content-type", TYPES[path.extname(f)] ?? "application/octet-stream"); fs.createReadStream(f).pipe(r);
    } catch (e) { r.statusCode = 500; r.end(JSON.stringify({ error: String(e.message || e) })); }
  });
  const wss = new WebSocketServer({ server, path: "/signal" });
  wss.on("connection", (ws, q) => { const uid = new URL(q.url, "http://x").searchParams.get("token"); sockets.set(uid, ws);
    ws.on("message", (raw) => { const m = JSON.parse(raw); const res = signal.handle(uid, m); if (m.ack) ws.send(JSON.stringify({ t: "ack", ack: m.ack, ...res })); });
    ws.on("close", () => { if (sockets.get(uid) === ws) { sockets.delete(uid); signal.disconnected(uid); } }); });
  await new Promise((ok) => server.listen(httpPort, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const relay = createRelay({ port: relayPort, verify: (t) => t || null, resolveTarget: gatewayTargetResolver({ url: `${base}/plain-target`, secret: RELAY_SECRET }) });
  await new Promise((ok) => relay.on("listening", ok));
  return { base, relayUrl: `ws://127.0.0.1:${relay.address().port}`, sessions, close: async () => { relay.close(); wss.close(); server.close(); worker.close(); } };
}
if (import.meta.url === `file://${process.argv[1]}`) startCiSfu({ httpPort: 8099 }).then((s) => console.log(JSON.stringify({ base: s.base, relay: s.relayUrl })));
