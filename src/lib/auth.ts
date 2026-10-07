// Client side of sessions v2: validate on launch, silent refresh, authenticated fetch.
// Nothing here ever surfaces an error to the user. Only a definitive answer from the server
// ("this refresh token is invalid / expired / revoked") signs someone out; network trouble, timeouts,
// 5xx and unexpected responses are retried quietly and never clear the session.

import { clearToken, loadCreds, loadSharedCreds, saveCreds, type Creds } from "./session";
import type { Me } from "./types";

/** refresh a little before the access token actually expires */
const SKEW_MS = 60_000;

export type AuthFail = "invalid" | "expired" | "revoked" | "reused";

/** Thrown when the server could not be reached (or answered oddly). Callers retry; the session is kept. */
export class TransientAuthError extends Error {
  transient = true;
  constructor() {
    super("offline");
  }
}
/** Thrown when the session is definitively gone (the caller shows the sign-in screen, no message). */
export class SignedOutError extends Error {
  constructor(readonly reason: AuthFail) {
    super("signed-out");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A device label for the server's session list ("web" vs native shells). */
export function deviceHint(): string {
  if (typeof navigator === "undefined") return "";
  const ua = navigator.userAgent;
  if (/OpenLoungeAndroid/i.test(ua)) return "android-app";
  if (/OpenLoungeiOS/i.test(ua)) return "ios-app";
  return "";
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body ?? {}),
      cache: "no-store",
      credentials: "same-origin",
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, data };
  } catch {
    throw new TransientAuthError();
  } finally {
    clearTimeout(timer);
  }
}

const isFail = (x: unknown): x is AuthFail => x === "invalid" || x === "expired" || x === "revoked" || x === "reused";

let inflight: Promise<Creds> | null = null;

/**
 * Exchange the refresh token for a new access token (rotating the refresh token). Single-flight per tab and,
 * where the Web Locks API exists, across tabs; if another tab already rotated the shared credentials we adopt
 * them instead of presenting a stale refresh token (which the server would treat as reuse).
 */
export function refreshSession(stale?: Creds | null): Promise<Creds> {
  if (inflight) return inflight;
  const run = async (): Promise<Creds> => {
    const mine = loadCreds();
    if (!mine) throw new SignedOutError("invalid");
    const shared = loadSharedCreds();
    // another tab (same person) rotated while we waited: use its fresh tokens
    if (shared && shared.refresh !== mine.refresh && (!mine.uid || shared.uid === mine.uid) && shared.access && shared.accessExp - SKEW_MS > Date.now()) {
      saveCreds(shared);
      return shared;
    }
    if (stale && mine.refresh !== stale.refresh && mine.access && mine.accessExp - SKEW_MS > Date.now()) return mine;
    for (let attempt = 0; ; attempt++) {
      try {
        const { status, data } = await postJson("/api/auth/refresh", { refreshToken: mine.refresh, device: deviceHint() });
        if (data?.ok && typeof data.access === "string" && typeof data.refresh === "string") {
          const user = data.user as Me | null;
          const next: Creds = { refresh: data.refresh, access: data.access, accessExp: Number(data.accessExpiresAt) || 0, uid: user?.id ?? mine.uid };
          saveCreds(next);
          return next;
        }
        if ((status === 401 || status === 400) && data && data.ok === false && isFail(data.reason)) {
          // the server says this session is over — unless another tab rotated it a moment ago
          const again = loadSharedCreds();
          if (again && again.refresh !== mine.refresh && (!mine.uid || again.uid === mine.uid)) {
            saveCreds(again);
            return again;
          }
          throw new SignedOutError(data.reason);
        }
        // 404/5xx/odd body (e.g. an older server during a deploy): treat as transient
        throw new TransientAuthError();
      } catch (err) {
        if (err instanceof SignedOutError) throw err;
        if (attempt >= 4) throw new TransientAuthError();
        await sleep(Math.min(8_000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5));
      }
    }
  };
  const locks = typeof navigator !== "undefined" ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  const p = (locks?.request ? (locks.request("openlounge-auth-refresh", run) as unknown as Promise<Creds>) : run()).finally(() => {
    inflight = null;
  });
  inflight = p;
  return p;
}

/** A usable access token for this tab (refreshing silently when needed). */
export async function getAccessToken(): Promise<string> {
  const c = loadCreds();
  if (!c) throw new SignedOutError("invalid");
  if (c.access && c.accessExp - SKEW_MS > Date.now()) return c.access;
  return (await refreshSession(c)).access!;
}

export interface ValidatedSession {
  user: Me;
  following: string[];
  unreadDms: number;
}

/**
 * Launch check, before any sign-in/onboarding UI: is the stored session still good?
 *   → ValidatedSession          signed in (access refreshed silently if it had expired)
 *   → null                      no stored session, or the server definitively rejected it (storage cleared)
 *   → throws TransientAuthError offline / server unreachable: keep the session, show the splash, retry
 */
export async function validateStoredSession(): Promise<ValidatedSession | null> {
  if (!loadCreds()) return null;
  for (let pass = 0; pass < 2; pass++) {
    let access: string;
    try {
      access = await getAccessToken();
    } catch (err) {
      if (err instanceof SignedOutError) {
        clearToken();
        return null;
      }
      throw err;
    }
    let status: number;
    let data: Record<string, unknown> | null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch("/api/auth/validate", { headers: { Authorization: `Bearer ${access}` }, cache: "no-store", signal: ctrl.signal });
      clearTimeout(timer);
      status = res.status;
      data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    } catch {
      throw new TransientAuthError();
    }
    if (data?.ok && data.user) {
      const c = loadCreds();
      if (c && !c.uid) saveCreds({ ...c, uid: (data.user as Me).id });
      return { user: data.user as Me, following: (data.following as string[]) ?? [], unreadDms: Number(data.unreadDms) || 0 };
    }
    if (status === 401 && data && isFail(data.reason)) {
      // access token rejected: refresh once (also covers an access token signed before a secret change)
      const c = loadCreds();
      if (c) saveCreds({ ...c, access: null, accessExp: 0 });
      continue;
    }
    throw new TransientAuthError();
  }
  throw new TransientAuthError();
}

/**
 * fetch() with the session attached. On 401 it refreshes silently and retries once; network errors are
 * retried with backoff. Callers get the Response (or a TransientAuthError) — never a raw auth error.
 */
export async function authFetch(input: string, init: RequestInit = {}, retries = 2): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const access = await getAccessToken();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${access}`);
    let res: Response;
    try {
      res = await fetch(input, { ...init, headers, cache: "no-store" });
    } catch {
      if (attempt >= retries) throw new TransientAuthError();
      await sleep(600 * 2 ** attempt);
      continue;
    }
    if (res.status === 401 && attempt < 1) {
      const c = loadCreds();
      if (c) await refreshSession({ ...c, access: null, accessExp: 0 });
      continue;
    }
    return res;
  }
}

/** Revoke this device's session on the server (best effort), then forget it locally. */
export async function logout(all = false) {
  const c = loadCreds();
  if (c) {
    try {
      await postJson("/api/auth/logout", { refreshToken: c.refresh, all }, c.access ? { Authorization: `Bearer ${c.access}` } : {}, 5_000);
    } catch {
      /* offline: the token is still dropped locally */
    }
  }
  clearToken();
}

/**
 * Mirror the current refresh token into the server's httpOnly cookie (after a socket sign-in, which can't set
 * cookies). Best effort: a failure only means the cookie fallback isn't there yet.
 */
export async function persistSessionCookie(): Promise<void> {
  const c = loadCreds();
  if (!c) return;
  try {
    await postJson("/api/auth/persist", { refreshToken: c.refresh }, {}, 8_000);
  } catch {
    /* offline: next refresh sets it */
  }
}

/**
 * Web storage is empty (evicted by the browser, cleared, new WebView profile): try the httpOnly refresh cookie.
 * → Creds when the server still knows the session; null when there is no cookie / it was rejected.
 * Throws TransientAuthError when offline so the caller can retry instead of showing the sign-in screen.
 */
export async function recoverFromCookie(): Promise<Creds | null> {
  if (loadCreds()) return loadCreds();
  const { status, data } = await postJson("/api/auth/refresh", { device: deviceHint() });
  if (data?.ok && typeof data.access === "string" && typeof data.refresh === "string") {
    const user = data.user as Me | null;
    const next: Creds = { refresh: data.refresh, access: data.access, accessExp: Number(data.accessExpiresAt) || 0, uid: user?.id ?? null };
    saveCreds(next);
    return next;
  }
  if (status === 401 || status === 400) return null;
  throw new TransientAuthError();
}
