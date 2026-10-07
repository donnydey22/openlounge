// Session tokens (v2): short-lived signed access tokens + long-lived rotating refresh tokens.
//
//   access token   "ol1.<sessionId>.<expiresAt base36>.<hmac>"  — 1 h, stateless signature, but every check
//                  also looks the session up (revocation is instant). Nothing about it is stored.
//   refresh token  32 random bytes (base64url) — 90 days, sliding. Only its SHA-256 is stored (sessions.token_hash).
//                  Rotated on every /auth/refresh; presenting an already-rotated token outside a short grace
//                  window is treated as theft and revokes the whole session ("family").
//   legacy token   pre-v2 opaque session tokens (same shape as refresh tokens). Existing rows were backfilled by
//                  migration 003 with legacy_hash = token_hash, so those tokens keep working everywhere
//                  (ws session:resume, /auth/validate, /auth/refresh, LiveKit) until the session expires or is revoked.
//
// The HMAC secret comes from AUTH_SECRET, else is generated once and kept in the database (openlounge_meta) /
// DATA_DIR, so access tokens survive restarts and redeploys.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ACCESS_TTL_MS = Number(process.env.AUTH_ACCESS_TTL_MS || 60 * 60_000); // 1 h
export const REFRESH_TTL_MS = Number(process.env.AUTH_REFRESH_TTL_MS || 90 * 24 * 60 * 60_000); // 90 days, sliding
/** a just-rotated refresh token is still accepted this long (two tabs refreshing at once, a lost response) */
export const ROTATION_GRACE_MS = 2 * 60_000;
/** rotated-out refresh hashes remembered per session for reuse detection */
export const MAX_PREV_HASHES = 8;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newOpaqueToken = () => randomBytes(32).toString("base64url");
export const newSessionId = () => `s_${randomBytes(16).toString("hex")}`;

// ---------- signing keys (rotation-aware) ----------
//
//   AUTH_SECRET            current signing key (preferred). Unset → the key stored in the DB (openlounge_meta) / DATA_DIR.
//   AUTH_SECRET_PREVIOUS   comma-separated old keys, accepted for VERIFICATION only (rotation grace; drop after >= ACCESS_TTL).
//   When AUTH_SECRET is set, the stored DB key is still accepted for verification (smooth cut-over from the DB key);
//   set AUTH_SECRET_ACCEPT_DB=0 once every token signed with it has expired (1 h after the switch).
//
// Tokens carry a key id: "ol1.<sid>.<exp36>.<sig>.<kid>" (kid = first 8 hex of sha256(key)). Tokens without a kid
// (issued before this change) are verified against every known key.

export type AuthKey = { kid: string; key: Buffer; source: string };
const kidOf = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 8);
const mkKey = (s: string, source: string): AuthKey => ({ kid: kidOf(s), key: Buffer.from(s, "utf8"), source });

let signing: AuthKey | null = null;
let verifying = new Map<string, AuthKey>();

/** Build the key ring. `dbSecret` = key persisted with the data (may be undefined). Returns a summary for logs (no secrets). */
export function configureAuthKeys(opts: { env?: Record<string, string | undefined>; dbSecret?: string | null } = {}) {
  const env = opts.env ?? process.env;
  const current = env.AUTH_SECRET?.trim();
  const previous = (env.AUTH_SECRET_PREVIOUS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const db = opts.dbSecret?.trim() || null;
  const ring: AuthKey[] = [];
  if (current) ring.push(mkKey(current, "env:AUTH_SECRET"));
  else if (db) ring.push(mkKey(db, "db"));
  else ring.push(mkKey(randomBytes(32).toString("hex"), "ephemeral"));
  for (const p of previous) ring.push(mkKey(p, "env:AUTH_SECRET_PREVIOUS"));
  if (current && db && env.AUTH_SECRET_ACCEPT_DB !== "0") ring.push(mkKey(db, "db"));
  signing = ring[0];
  verifying = new Map();
  for (const k of ring) if (!verifying.has(k.kid)) verifying.set(k.kid, k);
  return { signingKid: signing.kid, signingSource: signing.source, verifyKids: [...verifying.values()].map((k) => `${k.kid}(${k.source})`) };
}

/** @deprecated kept for scripts/tests: single key, no rotation */
export function setAuthSecret(s: string) {
  configureAuthKeys({ env: { AUTH_SECRET: s } });
}
function signingKey() {
  // only reachable before store.init() — keeps tests/scripts working; real servers always configure keys
  if (!signing) configureAuthKeys();
  return signing!;
}

const mac = (key: Buffer, payload: string) => createHmac("sha256", key).update(payload).digest("base64url");
const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function signAccessToken(sessionId: string, expiresAt: number) {
  const k = signingKey();
  const payload = `ol1.${sessionId}.${expiresAt.toString(36)}`;
  return `${payload}.${mac(k.key, payload)}.${k.kid}`;
}

export const isAccessToken = (t: unknown): t is string => typeof t === "string" && t.startsWith("ol1.");

/** Verify signature + expiry. Does NOT check the session (caller does). */
export function parseAccessToken(token: string): { ok: true; sessionId: string; expiresAt: number; kid: string } | { ok: false; reason: "invalid" | "expired"; sessionId?: string } {
  signingKey();
  const parts = token.split(".");
  if ((parts.length !== 4 && parts.length !== 5) || parts[0] !== "ol1") return { ok: false, reason: "invalid" };
  const [, sessionId, exp36, sig, kid] = parts;
  const payload = `ol1.${sessionId}.${exp36}`;
  const candidates = kid !== undefined ? [verifying.get(kid)].filter((k): k is AuthKey => !!k) : [...verifying.values()];
  const hit = candidates.find((k) => eq(sig, mac(k.key, payload)));
  if (!hit) return { ok: false, reason: "invalid" };
  const expiresAt = parseInt(exp36, 36);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: "invalid" };
  if (expiresAt <= Date.now()) return { ok: false, reason: "expired", sessionId };
  return { ok: true, sessionId, expiresAt, kid: hit.kid };
}

/** Short device/platform label for a session, from the client hint or the User-Agent. */
export function deviceLabel(hint: unknown, userAgent: string | undefined): string {
  const h = typeof hint === "string" ? hint.trim().slice(0, 40) : "";
  if (/^[\w .:/-]+$/.test(h)) return h;
  const ua = userAgent ?? "";
  if (/OpenLoungeAndroid/i.test(ua)) return "android-app";
  if (/OpenLoungeiOS/i.test(ua)) return "ios-app";
  const os = /Android/i.test(ua) ? "android" : /iPhone|iPad|iPod/i.test(ua) ? "ios" : /Mac OS X/i.test(ua) ? "mac" : /Windows/i.test(ua) ? "windows" : /Linux/i.test(ua) ? "linux" : "";
  const br = /Edg\//.test(ua) ? "edge" : /Firefox\//.test(ua) ? "firefox" : /Chrome\//.test(ua) ? "chrome" : /Safari\//.test(ua) ? "safari" : ua ? "other" : "";
  return ["web", os, br].filter(Boolean).join(":") || "unknown";
}

// ---------- CORS / Origin policy (HTTP API + WebSocket upgrade) ----------

const DEFAULT_ORIGINS = [
  "https://openlounge.app",
  "https://www.openlounge.app",
  "https://openlounge-production.up.railway.app",
];
const allowed = new Set(
  [...DEFAULT_ORIGINS, ...(process.env.CORS_ALLOWED_ORIGINS ?? "").split(",")].map((o) => o.trim().replace(/\/+$/, "").toLowerCase()).filter(Boolean),
);

/**
 * Is a request Origin allowed? Same-origin (Origin host == Host header, incl. localhost dev and both prod domains)
 * and the explicit allowlist pass. A missing Origin (native clients, bots, curl, same-origin GETs) is allowed —
 * those aren't browser cross-site requests.
 */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  const o = origin.trim().toLowerCase();
  if (allowed.has(o)) return true;
  // native app shells (Expo/Capacitor-style WebViews send their scheme as Origin)
  if (/^(openlounge|capacitor|ionic):\/\/[a-z0-9.-]*$/.test(o)) return true;
  if (o === "null") return false;
  try {
    const u = new URL(o);
    if (host && u.host === host.toLowerCase()) return true;
  } catch {
    return false;
  }
  return false;
}
