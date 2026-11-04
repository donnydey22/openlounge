// Mirror of ws-media-relay/src/token.mjs mint (same format; relay verifies). Pins the browser WS->UDP relay to one SFU tuple.
import crypto from "node:crypto";
export function mintRelayToken(secret: string, o: { userId: string; callId: string; host: string; port: number; ttlSec?: number }): string {
  const body = Buffer.from(JSON.stringify({ u: o.userId, c: o.callId, h: o.host, p: o.port, e: Math.floor(Date.now() / 1000) + (o.ttlSec ?? 3600) })).toString("base64url");
  return `${body}.${crypto.createHmac("sha256", secret).update(body).digest("base64url")}`;
}
