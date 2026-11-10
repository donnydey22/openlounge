// olcall (Pion + tgcalls media server on the OL DigitalOcean droplet) join tokens + CallMedia for eligible calls.
// Token format == olcall/server/protocol.go SignToken (pinned by tests/calls/olcallToken.test.ts):
//   base64url(json{callId,userId,role,exp}) "." base64url(HMAC-SHA256(secret, part1))
// The secret (same bytes as the droplet's /etc/olcall/token-secret) comes from OLCALL_TOKEN_SECRET or
// OLCALL_TOKEN_SECRET_FILE and is never logged or returned. EVERY call participant gets provider "olcall"; p2p media is
// stripped from every payload (single path, no fallback of any kind; Donny 2026-11-09 11:25 PM MST). Rollback = redeploy 5923712.
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

/** Participant check only: there is no switch and no other media path. */
export function olcallEligible(call: OlcallCallRef | null | undefined, userId: string): boolean {
  return !!call?.id && !!call.callerId && !!call.calleeId && (userId === call.callerId || userId === call.calleeId);
}

/**
 * The ONLY media any call participant gets: olcall (url + per-user join token). The p2p media the calling authority
 * produced is never passed through. Not a participant, or secret/url missing -> null (the call fails; no fallback).
 */
export function olcallMediaFor(call: OlcallCallRef | null | undefined, userId: string, env: Env = process.env, now = Date.now()): CallMedia | null {
  const url = env.OLCALL_URL ?? "";
  if (!olcallEligible(call, userId) || !(url.startsWith("wss://") || url.startsWith("ws://"))) return null;
  const secret = olcallSecret(env);
  if (!secret) return null;
  const exp = Math.floor(now / 1000) + OLCALL_TOKEN_TTL_S;
  const role: OlcallRole = userId === call!.callerId ? "caller" : "callee";
  return { provider: "olcall", url, token: signOlcallToken(secret, { callId: call!.id, userId, role, exp }), callId: call!.id, expiresAt: exp };
}

/** Replace any media in {call, media} payloads (acks, call:incoming / call:state emits) with olcall media. Never throws. */
export function withOlcallMedia<T>(userId: string, payload: T, env: Env = process.env): T {
  try {
    const p = payload as unknown as { call?: OlcallCallRef; media?: CallMedia | null };
    if (!p || typeof p !== "object" || !("media" in p)) return payload;
    return { ...p, media: p.call ? olcallMediaFor(p.call, userId, env) : null } as unknown as T;
  } catch {
    const p = payload as unknown as Record<string, unknown>;
    return (p && typeof p === "object" && "media" in p ? { ...p, media: null } : payload) as T;
  }
}
