// Runs before ./env (first import of mediaToken.test.ts): a fake LiveKit RoomService (Twirp over HTTP) that records
// server-side calls, a short call-token lifetime, and a dedicated test database.
import http from "node:http";
export const twirp: { path: string; body: any; at: number }[] = [];
export const fakeLiveKit = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    let body: any = null;
    try { body = JSON.parse(b || "null"); } catch {}
    twirp.push({ path: req.url ?? "", body, at: Date.now() });
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
});
// server modules are imported inside startApp(), so the URL only has to be set before then; listen() runs in before()
const PORT = 41000 + Math.floor(Math.random() * 8000);
process.env.LIVEKIT_URL = `ws://127.0.0.1:${PORT}`;
export const listenFakeLiveKit = () => new Promise<void>((r, j) => fakeLiveKit.once("error", j).listen(PORT, "127.0.0.1", () => r()));
process.env.CALL_TOKEN_TTL_S = "6";
process.env.CALL_RING_TIMEOUT_MS = "20000";
