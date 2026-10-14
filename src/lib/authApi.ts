// Client helpers for the unified sign-in methods (email, Google, Apple) and account linking.
// Phone login stays on the WebSocket (auth:requestCode / auth:verifyCode) exactly as before.
// Errors are friendly strings for inline form messages only — no error UI for sessions.

import { getAccessToken } from "./auth";
import { hasNativeStore } from "./session";
import type { Me } from "./types";
import { uaLooksNative, uaNativePlatform } from "@/lib/appBuild";

export type ProviderFlags = { phone: boolean; email: boolean; google: boolean; apple: boolean };
export type OAuthProvider = "google" | "apple";

export interface SessionResult {
  ok: true;
  status: "existing";
  token: string;
  refresh: string;
  access: string;
  accessExpiresAt: number;
  user: Me;
  following: string[];
  unreadDms: number;
}
export type SignInResult =
  | SessionResult
  | { ok: true; status: "new"; ticket: string; linkCode?: string; profile?: { firstName?: string; lastName?: string; email?: string | null } }
  | { ok: true; status: "linked"; provider: string }
  | { ok: true; status: "exists"; email?: string };

const NETWORK = "Can't reach Open Lounge right now. Check your connection and try again.";

export class AuthFormError extends Error {}

export async function authPost<T = Record<string, unknown>>(path: string, body: unknown, opts: { auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.auth) headers.Authorization = `Bearer ${await getAccessToken()}`;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: "POST", headers, body: JSON.stringify(body ?? {}), cache: "no-store" });
  } catch {
    throw new AuthFormError(NETWORK);
  }
  const data = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
  if (!data || data.ok === false || !res.ok) throw new AuthFormError(data?.error || (res.status >= 500 ? NETWORK : "Something went wrong. Please try again."));
  return data;
}

export async function authGet<T>(path: string, opts: { auth?: boolean } = {}): Promise<T | null> {
  try {
    const headers: Record<string, string> = {};
    if (opts.auth) headers.Authorization = `Bearer ${await getAccessToken()}`;
    const res = await fetch(`/api${path}`, { headers, cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

let providersCache: Promise<ProviderFlags> | null = null;
/** Which sign-in buttons to show. Anything unexpected → phone only (deploying without credentials changes nothing). */
export function fetchProviders(): Promise<ProviderFlags> {
  providersCache ??= authGet<{ providers: ProviderFlags }>("/auth/providers").then((r) => {
    if (!r?.providers) providersCache = null;
    return { phone: true, email: !!r?.providers?.email, google: !!r?.providers?.google, apple: !!r?.providers?.apple };
  });
  return providersCache;
}

// ---------- Google / Apple ----------

type NativeAuthBridge = { openAuth?: (url: string) => void | Promise<void>; getPlatform?: () => string };
const nativeBridge = () => (typeof window === "undefined" ? null : ((window as unknown as { OpenLoungeNative?: NativeAuthBridge }).OpenLoungeNative ?? null));

/** Inside a native shell (Android WebView / iOS wrapper)? */
export const inNativeShell = () => typeof navigator !== "undefined" && (hasNativeStore() || uaLooksNative());

/**
 * Can this client run Google/Apple sign-in? On the web: yes (full-page redirect). In a native shell only when the
 * shell offers OpenLoungeNative.openAuth(url) — Google refuses OAuth inside embedded WebViews, so the shell must open
 * the system browser (Custom Tab / ASWebAuthenticationSession) and route openlounge://auth?code=… back to
 * /auth/complete?code=… in the WebView.
 */
/**
 * Native wrapper platform ("android" | "ios"), or null on the plain web (desktop and mobile browsers, incl. iOS Safari).
 * Explicit native signals only, in order: the wrapper's bridge (OpenLoungeNative.getPlatform() / .platform — the iOS
 * Expo app and the Android app both inject it before the page's scripts run), then the wrapper's user-agent suffix
 * ("OpenLounge/<android|ios>/<v>(<build>)", plus legacy OpenLoungeiOS/<v> / OpenLoungeAndroid/<v>). Plain-browser UA sniffing is only
 * a last resort inside a shell that identified itself (native session store) but gave no platform.
 */
export function nativePlatform(): "android" | "ios" | null {
  try {
    const b = nativeBridge() as (NativeAuthBridge & { platform?: unknown }) | null;
    const p = b ? (typeof b.getPlatform === "function" ? b.getPlatform() : b.platform) : null;
    if (p === "android" || p === "ios") return p;
  } catch {
    /* ignore */
  }
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const fromUa = uaNativePlatform(ua);
  if (fromUa) return fromUa;
  if (!inNativeShell()) return null;
  return /Android/i.test(ua) ? "android" : /iPhone|iPad|iPod|Macintosh/i.test(ua) ? "ios" : null;
}

/** Sign in with Apple is offered on iOS and the web, not inside the Android app (Donny's call). */
export const showAppleHere = () => nativePlatform() !== "android";

/** Google sign-in is not offered inside the iOS app (Donny's call: Apple on iOS; Google on Android). The web keeps it. */
export const showGoogleHere = () => nativePlatform() !== "ios";

export const canUseOAuth = () => !inNativeShell() || typeof nativeBridge()?.openAuth === "function";

const VERIFIER_KEY = "openlounge:oauth-verifier";
const b64url = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf instanceof Uint8Array ? buf : new Uint8Array(buf)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** For the shell path: a verifier kept in this WebView + its S256 challenge sent with the start URL. */
async function appChallenge(): Promise<string> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  try {
    localStorage.setItem(VERIFIER_KEY, verifier);
  } catch {
    /* storage disabled */
  }
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}

export function takeVerifier(): string | undefined {
  try {
    const v = localStorage.getItem(VERIFIER_KEY);
    localStorage.removeItem(VERIFIER_KEY);
    return v ?? undefined;
  } catch {
    return undefined;
  }
}

async function go(url: string) {
  const bridge = nativeBridge();
  if (inNativeShell() && bridge?.openAuth) {
    await bridge.openAuth(new URL(url, location.origin).toString());
    return;
  }
  location.assign(url);
}

/** Start "Continue with Google/Apple" (sign in or sign up). */
export async function startOAuth(provider: OAuthProvider) {
  if (inNativeShell()) return go(`/auth/${provider}/start?app=1&cc=${await appChallenge()}`);
  return go(`/auth/${provider}/start`);
}

/** Settings → connect Google/Apple to the signed-in account. */
export async function startLink(provider: OAuthProvider) {
  const app = inNativeShell();
  const r = await authPost<{ url: string }>("/auth/link/start", { provider, app, ...(app ? { cc: await appChallenge() } : {}) }, { auth: true });
  return go(r.url);
}

// ---------- signup hand-off (OAuth / email link → existing onboarding screens) ----------

const PENDING_KEY = "openlounge:pending-signup";
export interface PendingSignup {
  ticket: string;
  firstName?: string;
  lastName?: string;
  email?: string | null;
  method: "email" | "google" | "apple";
  /** "Already have an account?": single-use code to link this identity to a phone account instead */
  linkCode?: string;
}
export function savePendingSignup(p: PendingSignup) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...p, at: Date.now() }));
  } catch {
    /* ignore */
  }
}
export function takePendingSignup(): PendingSignup | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingSignup & { at: number };
    return Date.now() - p.at < 25 * 60_000 && typeof p.ticket === "string" ? p : null;
  } catch {
    return null;
  }
}

/**
 * "Already have an account?": prove the phone number (Firebase ID token) and attach the pending Google/Apple/email
 * identity to that account. On a recoverable error the server hands back a fresh linkCode.
 */
export async function linkPendingToPhone(linkCode: string, idToken: string, device?: string): Promise<{ ok: true; res: SessionResult & { linked: string } } | { ok: false; error: string; linkCode?: string }> {
  try {
    const r = await fetch("/api/auth/link/phone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ linkCode, idToken, device }), cache: "no-store" });
    const data = (await r.json().catch(() => null)) as (SessionResult & { linked: string; ok: boolean; error?: string; linkCode?: string }) | null;
    if (r.ok && data?.ok) return { ok: true, res: data };
    return { ok: false, error: data?.error || "Something went wrong. Please try again.", linkCode: data?.linkCode };
  } catch {
    return { ok: false, error: NETWORK };
  }
}

/** Set after a phone sign-in; Settings shows a gentle "add Google or Apple" prompt until dismissed or done. */
export const SUGGEST_LINK_KEY = "openlounge:suggest-link";
export function markSuggestLink() {
  try {
    if (localStorage.getItem(SUGGEST_LINK_KEY) !== "dismissed") localStorage.setItem(SUGGEST_LINK_KEY, "1");
  } catch {
    /* storage disabled */
  }
}

export const OAUTH_ERRORS: Record<string, string> = {
  cancelled: "Sign-in was cancelled. You can try again anytime.",
  expired: "That sign-in took too long. Please try again.",
  taken: "That account is already linked to a different Open Lounge account with its own messages, rooms or follows, so it can't be moved automatically.",
  unavailable: "That sign-in option isn't available right now.",
  busy: "Too many attempts. Please wait a few minutes and try again.",
  failed: "We couldn't sign you in with that account. Please try again.",
};
