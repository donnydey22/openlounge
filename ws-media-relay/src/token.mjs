// Option B relay token: the main server mints it on ms:plain:create; it pins the UDP target (SFU ip:port) so the relay
// can never be pointed anywhere else. token = base64url(json{u,c,h,p,e}).hmac
import crypto from "node:crypto";
export function mintRelayToken(secret, { userId, callId, host, port, ttlSec = 3600 }) {
  const body = Buffer.from(JSON.stringify({ u: userId, c: callId, h: host, p: port, e: Math.floor(Date.now() / 1000) + ttlSec })).toString("base64url");
  return `${body}.${crypto.createHmac("sha256", secret).update(body).digest("base64url")}`;
}
export function verifyRelayToken(secret, token) {
  const [body, sig] = String(token || "").split("."); if (!body || !sig) return null;
  const want = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try { const j = JSON.parse(Buffer.from(body, "base64url").toString()); return j.e * 1000 > Date.now() ? j : null; } catch { return null; }
}
