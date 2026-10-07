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
  emailCodeIp: { max: 20, windowMs: 60 * 60_000 },
  emailCodeEmail: { max: 5, windowMs: 60 * 60_000 },
  emailVerifyIp: { max: 40, windowMs: 15 * 60_000 },
  usernameLoginIp: { max: 30, windowMs: 15 * 60_000 },
  usernameLookupIp: { max: 15, windowMs: 60 * 60_000 },
  usernameCodeUser: { max: 5, windowMs: 60 * 60_000 },
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

// ---------- lockout (failed password attempts) ----------
// Only FAILURES count, so a person who knows their password is never throttled by their own sign-ins.
//   per username+IP: 5 failures → locked 15 min (one guesser can't grind one account)
//   per username (any IP): 20 failures / hour → locked 1 h (a botnet spreading guesses still hits a wall)
// Keyed by the normalized username whether or not it exists (a lock never reveals that an account exists).

export const LOCKOUT = {
  pair: { max: 5, windowMs: 15 * 60_000 },
  user: { max: 20, windowMs: 60 * 60_000 },
} satisfies Record<string, Limit>;

const failures = new Map<string, number[]>();
const live = (key: string, l: Limit, now: number) => (failures.get(key) ?? []).filter((t) => now - t < l.windowMs);

export function isLockedOut(username: string, ip: string, now = Date.now()) {
  return live(`pair:${username}:${ip}`, LOCKOUT.pair, now).length >= LOCKOUT.pair.max || live(`user:${username}`, LOCKOUT.user, now).length >= LOCKOUT.user.max;
}

export function recordFailure(username: string, ip: string, now = Date.now()) {
  for (const [key, l] of [[`pair:${username}:${ip}`, LOCKOUT.pair], [`user:${username}`, LOCKOUT.user]] as const) {
    const list = live(key, l, now);
    list.push(now);
    failures.set(key, list);
  }
  if (failures.size > 20_000) for (const [k, v] of failures) if (!v.length || now - v[v.length - 1] > 3_600_000) failures.delete(k);
}

/** a correct password clears this IP's strikes (the account-wide counter keeps running) */
export function clearFailures(username: string, ip: string) {
  failures.delete(`pair:${username}:${ip}`);
}

/** test helper */
export function resetRateLimits() {
  hits.clear();
  failures.clear();
}
