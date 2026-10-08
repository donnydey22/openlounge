// Per-call decline tokens for the native ring UIs (CallKit / Android full-screen call screen).
// The ring push (VoIP + FCM call_incoming) carries `declineToken`; POST /api/calls/<id>/decline with the header
// `X-Call-Decline-Token: <token>` (or JSON body {declineToken}) declines WITHOUT a session, so Decline still works when
// the app's 1-hour access token has expired. A token is:
//   - scoped to ONE call id and ONE callee (both inside the HMAC),
//   - short-lived: expires at the ring deadline (call.expiresAt) + a small grace (default 15 s),
//   - single-use: the nonce is remembered until expiry and a replay is rejected.
// Format: v1.<base64url(JSON{c,u,e,n})>.<base64url(HMAC-SHA256)>. The key is CALL_DECLINE_SECRET if set, otherwise
// random per process (calls live in memory, so a restart ends every ringing call anyway).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DECLINE_TOKEN_GRACE_MS = Math.max(0, Number(process.env.CALL_DECLINE_TOKEN_GRACE_MS) || 15_000);
export const DECLINE_TOKEN_HEADER = "x-call-decline-token";

type Claims = { c: string; u: string; e: number; n: string };
export type VerifyResult = { ok: true; callId: string; userId: string } | { ok: false; reason: "malformed" | "signature" | "expired" | "wrong_call" | "replayed" };

export class DeclineTokens {
  private readonly key: Buffer;
  private readonly used = new Map<string, number>(); // nonce → expiry (ms)
  constructor(secret?: string, private readonly now: () => number = Date.now) {
    this.key = secret && secret.length >= 16 ? Buffer.from(secret) : randomBytes(32);
  }

  private sign(body: string) {
    return createHmac("sha256", this.key).update(`v1.${body}`).digest("base64url");
  }

  /** token for `userId` (the callee) to decline `callId`; valid until `ringDeadline` + grace */
  mint(callId: string, userId: string, ringDeadline: number) {
    const claims: Claims = { c: callId, u: userId, e: ringDeadline + DECLINE_TOKEN_GRACE_MS, n: randomBytes(12).toString("base64url") };
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `v1.${body}.${this.sign(body)}`;
  }

  /** checks signature, scope and expiry WITHOUT consuming the token */
  inspect(token: unknown, callId: string): VerifyResult & { nonce?: string; exp?: number } {
    if (typeof token !== "string" || token.length > 600) return { ok: false, reason: "malformed" };
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, reason: "malformed" };
    const [, body, sig] = parts;
    const want = Buffer.from(this.sign(body));
    const got = Buffer.from(sig);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "signature" };
    let cl: Claims;
    try {
      cl = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (!cl || typeof cl.c !== "string" || typeof cl.u !== "string" || typeof cl.e !== "number" || typeof cl.n !== "string") return { ok: false, reason: "malformed" };
    if (this.now() > cl.e) return { ok: false, reason: "expired" };
    if (cl.c !== callId) return { ok: false, reason: "wrong_call" };
    if (this.used.has(cl.n)) return { ok: false, reason: "replayed" };
    return { ok: true, callId: cl.c, userId: cl.u, nonce: cl.n, exp: cl.e };
  }

  /** marks the token used; false if it was already used (lost a race) */
  consume(nonce: string, exp: number) {
    this.sweep();
    if (this.used.has(nonce)) return false;
    this.used.set(nonce, exp);
    return true;
  }

  /** inspect + consume in one step */
  verify(token: unknown, callId: string): VerifyResult {
    const r = this.inspect(token, callId);
    if (!r.ok) return r;
    if (!this.consume(r.nonce!, r.exp!)) return { ok: false, reason: "replayed" };
    return { ok: true, callId: r.callId, userId: r.userId };
  }

  private sweep() {
    if (this.used.size < 256) return;
    const t = this.now();
    for (const [n, e] of this.used) if (e < t) this.used.delete(n);
  }

  get usedCount() {
    return this.used.size;
  }
}

let shared: DeclineTokens | null = null;
export const declineTokens = () => (shared ??= new DeclineTokens(process.env.CALL_DECLINE_SECRET));
