// Deployable entry (NOT deployed). Auth = same HMAC call token as call-signal. Target = SFU PlainTransport tuple
// published by media-sfu plain:create via the gateway (call-signal /plain-target).
import http from "node:http";
import crypto from "node:crypto";
import { createRelay, gatewayTargetResolver } from "./relay.mjs";
const SECRET = process.env.CALL_SIGNAL_SECRET;
if (!SECRET || !process.env.RELAY_SECRET) { console.error("missing CALL_SIGNAL_SECRET/RELAY_SECRET"); process.exit(1); }
const verify = (t) => { const [u, e, s] = String(t || "").split("."); if (!u || !e || !s || Number(e) * 1000 < Date.now()) return null;
  const w = crypto.createHmac("sha256", SECRET).update(`${u}.${e}`).digest("base64url");
  return w.length === s.length && crypto.timingSafeEqual(Buffer.from(w), Buffer.from(s)) ? u : null; };
const resolveTarget = gatewayTargetResolver({ url: process.env.PLAIN_TARGET_URL || "http://127.0.0.1:8090/plain-target", secret: process.env.RELAY_SECRET });
const server = http.createServer((q, r) => { r.end(q.url === "/health" ? "ok" : ""); });
createRelay({ server, verify, resolveTarget });
server.listen(Number(process.env.PORT || 8092), "127.0.0.1");
