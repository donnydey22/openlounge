// olcall (Pion + tgcalls media server on the OL DigitalOcean droplet) join tokens + CallMedia for eligible calls.
// Token format == olcall/server/protocol.go SignToken (pinned by tests/calls/olcallToken.test.ts):
//   base64url(json{callId,userId,role,exp}) "." base64url(HMAC-SHA256(secret, part1))
// The secret (same bytes as the droplet's /etc/olcall/token-secret) comes from OLCALL_TOKEN_SECRET or
// OLCALL_TOKEN_SECRET_FILE and is never logged or returned. Off unless OLCALL_ENABLED=1; then only calls where BOTH
// parties are listed in OLCALL_TEST_USERS ("*" = everyone) and BOTH report platform "android" get provider "olcall". Every other
// call keeps the unchanged p2p media (old apps, iOS, web).
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CallMedia } from "../../src/lib/types";

export type OlcallRole = "caller" | "callee";
export interface OlcallClaims { callId: string; userId: string; role: OlcallRole; exp: number }

/** Covers ringing (<= ~60 s) -> join; a fresh token is minted on every call:get / call:state. */
export const OLCALL_TOKEN_TTL_S = 300;

const b64url = (b: Buffer) => b.toString("base64url");

export function signOlcallToken(secret: Buffer | string, c: OlcallClaims): string {
  if (!c.callId || !c.userId || (c.role !== "caller" && c.role !== "callee") || !Number.isInteger(c.exp)) {
    throw new Error("olcall token: invalid claims");
  }
  const key = typeof secret === "string" ? Buffer.from(secret) : secret;
  if (key.length < 32) throw new Error("olcall token: secret must be >= 32 bytes");
  // Explicit field order == Go struct order (callId, userId, role, exp).
  const p1 = b64url(Buffer.from(JSON.stringify({ callId: c.callId, userId: c.userId, role: c.role, exp: c.exp }), "utf8"));
  return `${p1}.${b64url(createHmac("sha256", key).update(p1).digest())}`;
}

type Env = Record<string, string | undefined>;

export function olcallSecret(env: Env = process.env): Buffer | null {
  try {
    const raw = env.OLCALL_TOKEN_SECRET ?? (env.OLCALL_TOKEN_SECRET_FILE ? readFileSync(env.OLCALL_TOKEN_SECRET_FILE, "utf8") : "");
    const s = Buffer.from(raw.trim()); // olcall-server trims the file the same way
    return s.length >= 32 ? s : null;
  } catch {
    return null;
  }
}

export interface OlcallCallRef { id: string; callerId: string; calleeId: string; callerPlatform?: string; calleePlatform?: string }

/** Pure gate: is this call olcall-eligible for userId? (No secret material involved.) */
export function olcallEligible(call: OlcallCallRef | null | undefined, userId: string, env: Env = process.env): boolean {
  if (env.OLCALL_ENABLED !== "1" || !call?.id || !call.callerId || !call.calleeId) return false;
  if (userId !== call.callerId && userId !== call.calleeId) return false;
  const url = env.OLCALL_URL ?? "";
  if (!url.startsWith("wss://") && !url.startsWith("ws://")) return false;
  const allow = new Set((env.OLCALL_TEST_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  if (!allow.has("*") && (!allow.has(call.callerId) || !allow.has(call.calleeId))) return false;
  return call.callerPlatform === "android" && call.calleePlatform === "android";
}

/**
 * The media this user should get for this call: olcall media (url + per-user token) when eligible, else `base`
 * unchanged (the existing p2p media). Keeps base.iceServers (OL TURN creds) as the app-side relay-list fallback.
 */
export function olcallMediaFor(call: OlcallCallRef | null | undefined, userId: string, base: CallMedia | null | undefined, env: Env = process.env, now = Date.now()): CallMedia | null | undefined {
  if (!base || !olcallEligible(call, userId, env)) return base;
  const secret = olcallSecret(env);
  if (!secret) return base;
  const exp = Math.floor(now / 1000) + OLCALL_TOKEN_TTL_S;
  const role: OlcallRole = userId === call!.callerId ? "caller" : "callee";
  return {
    provider: "olcall",
    url: env.OLCALL_URL!,
    token: signOlcallToken(secret, { callId: call!.id, userId, role, exp }),
    callId: call!.id,
    expiresAt: exp,
    ...(base.iceServers?.length ? { iceServers: base.iceServers } : {}),
  };
}

/** Rewrite {call, media} payloads (acks and call:incoming / call:state emits) for one recipient; never throws. */
export function withOlcallMedia<T>(userId: string, payload: T, env: Env = process.env): T {
  try {
    const p = payload as unknown as { call?: OlcallCallRef; media?: CallMedia | null };
    if (!p || typeof p !== "object" || !p.call || !p.media || p.media.provider !== "p2p") return payload;
    const media = olcallMediaFor(p.call, userId, p.media, env);
    return media === p.media ? payload : ({ ...p, media } as unknown as T);
  } catch {
    return payload;
  }
}
