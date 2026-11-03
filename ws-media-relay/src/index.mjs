// Deployable entry (NOT deployed). Auth = same HMAC call token as call-signal. Target = SFU PlainTransport tuple
// published by the media-sfu gateway for (callId,userId); stub map until the gateway RPC is wired (M5).
import http from "node:http";
import crypto from "node:crypto";
import { createRelay } from "./relay.mjs";
const SECRET = process.env.CALL_SIGNAL_SECRET;
if (!SECRET) { console.error("missing CALL_SIGNAL_SECRET"); process.exit(1); }
const verify = (t) => { const [u, e, s] = String(t || "").split("."); if (!u || !e || !s || Number(e) * 1000 < Date.now()) return null;
  const w = crypto.createHmac("sha256", SECRET).update(`${u}.${e}`).digest("base64url");
  return w.length === s.length && crypto.timingSafeEqual(Buffer.from(w), Buffer.from(s)) ? u : null; };
export const targets = new Map(); // `${callId}:${userId}` -> {host,port}
const server = http.createServer((q, r) => { r.end(q.url === "/health" ? "ok" : ""); });
createRelay({ server, verify, resolveTarget: ({ callId, userId }) => targets.get(`${callId}:${userId}`) });
server.listen(Number(process.env.PORT || 8092), "127.0.0.1");
