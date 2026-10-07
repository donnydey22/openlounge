// In-memory sliding-window rate limits (per process). Keys look like "login:ip:1.2.3.4" / "login:email:a@b.c".
// Good enough for one Railway instance; limits reset on deploy (acceptable for abuse throttling).

const hits = new Map<string, number[]>();

export interface Limit {
  max: number;
  windowMs: number;
}

export const LIMITS = {
  loginIp: { max: 20, windowMs: 15 * 60_000 },
  loginEmail: { max: 8, windowMs: 15 * 60_000 },
  forgotIp: { max: 10, windowMs: 60 * 60_000 },
  forgotEmail: { max: 3, windowMs: 60 * 60_000 },
  resetIp: { max: 10, windowMs: 15 * 60_000 },
  resetEmail: { max: 5, windowMs: 60 * 60_000 },
  signupIp: { max: 10, windowMs: 60 * 60_000 },
  signupEmail: { max: 3, windowMs: 60 * 60_000 },
  exchangeIp: { max: 30, windowMs: 10 * 60_000 },
  oauthStartIp: { max: 30, windowMs: 10 * 60_000 },
} satisfies Record<string, Limit>;

/** Record a hit; returns false (and does not record) when the key is over its limit. */
export function allow(key: string, limit: Limit, now = Date.now()): boolean {
  const list = (hits.get(key) ?? []).filter((t) => now - t < limit.windowMs);
  if (list.length >= limit.max) {
    hits.set(key, list);
    return false;
  }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 20_000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 3_600_000) hits.delete(k);
  return true;
}

/** Would another hit be allowed? (doesn't record) */
export function peekAllowed(key: string, limit: Limit, now = Date.now()) {
  return (hits.get(key) ?? []).filter((t) => now - t < limit.windowMs).length < limit.max;
}

/** test helper */
export function resetRateLimits() {
  hits.clear();
}
