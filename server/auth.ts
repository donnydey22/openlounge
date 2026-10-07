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

let secret: Buffer | null = null;
export function setAuthSecret(s: string) {
  secret = Buffer.from(s, "utf8");
}
function key() {
  if (!secret) {
    // only reachable before store.init() — keeps tests/scripts working; real servers always call setAuthSecret
    secret = Buffer.from(process.env.AUTH_SECRET || randomBytes(32).toString("hex"), "utf8");
  }
  return secret;
}

const sign = (payload: string) => createHmac("sha256", key()).update(payload).digest("base64url");

export function signAccessToken(sessionId: string, expiresAt: number) {
  const payload = `ol1.${sessionId}.${expiresAt.toString(36)}`;
  return `${payload}.${sign(payload)}`;
}

export const isAccessToken = (t: unknown): t is string => typeof t === "string" && t.startsWith("ol1.");

/** Verify signature + expiry. Does NOT check the session (caller does). */
export function parseAccessToken(token: string): { ok: true; sessionId: string; expiresAt: number } | { ok: false; reason: "invalid" | "expired"; sessionId?: string } {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "ol1") return { ok: false, reason: "invalid" };
  const [, sessionId, exp36, sig] = parts;
  const expected = sign(`ol1.${sessionId}.${exp36}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "invalid" };
  const expiresAt = parseInt(exp36, 36);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: "invalid" };
  if (expiresAt <= Date.now()) return { ok: false, reason: "expired", sessionId };
  return { ok: true, sessionId, expiresAt };
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
  try {
    const u = new URL(o);
    if (host && u.host === host.toLowerCase()) return true;
  } catch {
    return false;
  }
  return false;
}
