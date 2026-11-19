// olcall (Pion + tgcalls media server on the OL DigitalOcean droplet) join tokens + CallMedia for eligible calls.
// Token format == olcall/server/protocol.go SignToken (pinned by tests/calls/olcallToken.test.ts):
//   base64url(json{callId,userId,role,exp}) "." base64url(HMAC-SHA256(secret, part1))
// The secret (same bytes as the droplet's /etc/olcall/token-secret) comes from OLCALL_TOKEN_SECRET or
// OLCALL_TOKEN_SECRET_FILE and is never logged or returned. EVERY call participant gets provider "olcall"; p2p media is
// stripped from every payload (single path, no fallback of any kind; Donny 2026-11-09 11:25 PM MST). Rollback = redeploy 5923712.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CallMedia, TurnIceServer } from "../../src/lib/types";
import { mintTurnIceServers, STUN_URLS } from "../turnCredentials";

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

export interface OlcallCallRef {
  id: string; callerId: string; calleeId: string; callerPlatform?: string; calleePlatform?: string;
  /** link call not yet joined by both: the join token expires with the link (epoch ms), not OLCALL_TOKEN_TTL_S */
  linkExpiresAt?: number;
}

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
  // A link's join token lives exactly as long as the link (the call server's LinkJoinTimeout, ten minutes from
  // creation); an expired link mints nothing. Every other call keeps the short OLCALL_TOKEN_TTL_S token.
  if (call!.linkExpiresAt !== undefined && call!.linkExpiresAt <= now) return null;
  const exp = call!.linkExpiresAt !== undefined ? Math.floor(call!.linkExpiresAt / 1000) : Math.floor(now / 1000) + OLCALL_TOKEN_TTL_S;
  const role: OlcallRole = userId === call!.callerId ? "caller" : "callee";
  const turn = mintTurnIceServers(call!.id, userId, { secret: env.OLCALL_TURN_SECRET ?? null }) ?? [];
  return {
    provider: "olcall", url, token: signOlcallToken(secret, { callId: call!.id, userId, role, exp }), callId: call!.id, expiresAt: exp,
    // same list Pion serves: STUN + TURN/TURNS on OL coturn with temporary shared-secret credentials (direct first, relay fallback)
    // (the STUN entry carries no credentials; CallMedia.iceServers is typed for the TURN shape the clients already parse)
    ...(turn.length ? { iceServers: [{ urls: [...STUN_URLS] } as unknown as TurnIceServer, ...turn] } : {}),
  };
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

// ── App-side call events -> call server (POST /v1/call-event) ──────────────────────────────────────────
// Mirrors backend/olcallToken.ts (ec9bf51) and olcall/server/events.go: same secret and base64url/HMAC encoding as the
// join token, but the claims carry "event" instead of "role", so neither token is accepted in place of the other.
// The call server stays the only writer of call state; this only asks it to transition (Idle -> Ringing -> Answering).
// Fire-and-forget by design: a lost event never blocks or ends a call (the server's leg simply goes Idle -> JoiningUrl
// on join, exactly as before this was wired).
export type OlcallEvent = "call:start" | "call:link" | "call:accept" | "call:decline" | "call:hangup" | "call:timeout" | "call:end";
const OLCALL_EVENTS: readonly OlcallEvent[] = ["call:start", "call:link", "call:accept", "call:decline", "call:hangup", "call:timeout", "call:end"];

/** One leg's snapshot as olcall/server/states.go CallSnapshot serializes it (the seven BaoTime states). */
export interface OlcallLegSnapshot {
  callId: string; leg: "caller" | "callee";
  state: "idle" | "ringing" | "answering" | "joining_url" | "connecting" | "in_room" | "terminal";
  reason?: string; seq: number; event?: string;
}
/** What the call server returned for one event: its status and the snapshots it now holds for each leg. */
export interface OlcallFireResult { status: number; legs: { caller?: OlcallLegSnapshot; callee?: OlcallLegSnapshot } }
const NO_RESULT = (status: number): OlcallFireResult => ({ status, legs: {} });

/** The app's legacy call.phase, read off a leg snapshot (installed builds parse call.phase). */
export function phaseOfLeg(s: OlcallLegSnapshot): "calling" | "ringing" | "active" | "ended" {
  switch (s.state) {
    case "idle": return "calling";
    case "ringing": return "ringing";
    case "terminal": return "ended";
    default: return "active";
  }
}
export const OLCALL_EVENT_TTL_S = 120;
export const OLCALL_EVENT_TIMEOUT_MS = 3000;

export function signOlcallEventToken(secret: Buffer | string, c: { callId: string; event: OlcallEvent; exp: number }): string {
  if (!c.callId || !OLCALL_EVENTS.includes(c.event) || !Number.isInteger(c.exp)) throw new Error("olcall event token: invalid claims");
  const key = typeof secret === "string" ? Buffer.from(secret) : secret;
  if (key.length < 32) throw new Error("olcall token: secret must be >= 32 bytes");
  // Explicit field order == Go EventClaims order (callId, event, exp).
  const p1 = b64url(Buffer.from(JSON.stringify({ callId: c.callId, event: c.event, exp: c.exp }), "utf8"));
  return `${p1}.${b64url(createHmac("sha256", key).update(p1).digest())}`;
}

/** wss://host/v1/call -> https://host/v1/call-event (OLCALL_EVENT_URL overrides). null when not configured. */
export function olcallEventUrl(env: Env = process.env): string | null {
  if (env.OLCALL_EVENT_URL) return env.OLCALL_EVENT_URL;
  const raw = env.OLCALL_URL ?? "";
  if (!(raw.startsWith("wss://") || raw.startsWith("ws://"))) return null;
  const u = new URL(raw);
  u.protocol = u.protocol === "ws:" ? "http:" : "https:";
  u.pathname = u.pathname.replace(/\/v1\/call\/?$/, "") + "/v1/call-event";
  return u.toString();
}

/**
 * Sends one event; resolves to the HTTP status (200 applied, 409 refused by the state machine, 404 unknown call, 401 bad
 * token, 0 when not configured / unreachable / timed out) and the leg snapshots the call server returned. Never throws,
 * never retried: the call server is the single writer of call:state, and only its returned snapshots are relayed.
 */
export async function forwardOlcallEvent(event: OlcallEvent, callId: string, env: Env = process.env, now = Date.now(),
  fetchImpl: typeof fetch = fetch): Promise<OlcallFireResult> {
  try {
    const url = olcallEventUrl(env); const secret = olcallSecret(env);
    if (!url || !secret || !callId) return NO_RESULT(0);
    const token = signOlcallEventToken(secret, { callId, event, exp: Math.floor(now / 1000) + OLCALL_EVENT_TTL_S });
    const r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(OLCALL_EVENT_TIMEOUT_MS) });
    const legs: OlcallFireResult["legs"] = {};
    try {
      const body = (await r.json()) as Record<string, OlcallLegSnapshot>;
      for (const k of ["caller", "callee"] as const) if (body?.[k] && body[k].callId === callId && body[k].leg === k) legs[k] = body[k];
    } catch { /* non-JSON body: status only */ }
    return { status: r.status, legs };
  } catch { return NO_RESULT(0); }
}

/**
 * Per-call ordered sender: events for one call are posted one after another (start before accept/decline), because
 * parallel HTTP requests can arrive out of order and the server's state machine would refuse accept-before-start.
 * Each send still has its own timeout, so a slow or dead call server delays only the observer events, never the call.
 */
export function olcallEventQueue(send: (event: OlcallEvent, callId: string) => Promise<OlcallFireResult> = forwardOlcallEvent,
  onResult: (event: OlcallEvent, callId: string, status: number) => void = () => {}) {
  const tails = new Map<string, Promise<unknown>>();
  return (event: OlcallEvent, callId: string): Promise<OlcallFireResult> => {
    const prev = tails.get(callId) ?? Promise.resolve();
    const next = prev.then(() => send(event, callId)).then(
      (r) => { try { onResult(event, callId, r.status); } catch { /* log only */ } return r; },
      () => NO_RESULT(0));
    tails.set(callId, next);
    void next.finally(() => { if (tails.get(callId) === next) tails.delete(callId); });
    return next;
  };
}
