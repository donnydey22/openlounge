// Deep links, universal links and the Google/Apple sign-in hand-off.
//
// Contract with the web app (openlounge unified-auth branch, server/authx/routes.ts + src/lib/authApi.ts):
//   page:   OpenLoungeNative.openAuth("https://openlounge.app/auth/google/start?app=1&cc=<S256>")
//   app:    ASWebAuthenticationSession (expo-web-browser openAuthSessionAsync), callback scheme "openlounge"
//   server: … → 302 openlounge://auth?code=<one-time code>   (or ?error=cancelled|expired|…)
//   app:    loads https://openlounge.app/auth/complete?code=… in the WebView; that page POSTs /auth/exchange
//           {code, codeVerifier} (verifier kept in the WebView's localStorage) and signs the user in.
// The same mapping is applied to links that arrive through iOS (cold start / Linking 'url' events):
//   openlounge://auth?code=…, openlounge://auth/exchange?code=…, openlounge://auth/complete?code=…,
//   https://openlounge.app/auth/exchange?code=…, https://openlounge.app/auth/complete?code=…
//   openlounge://room/abc → https://openlounge.app/room/abc
//   https://openlounge.app/<path> (universal link, once applinks: is enabled) → that page in the WebView

import { APP_SCHEME, AUTH_COMPLETE_PATH, appOriginOf, isAppHost, isAppUrl } from './config';
import { isSafeAppPath, parseUrl, queryParam } from './url';

const CODE_RE = /^[A-Za-z0-9._~-]{1,512}$/;
const ERROR_RE = /^[a-z_]{1,32}$/;
const AUTH_PATHS = new Set(['/auth', '/auth/', '/auth/exchange', '/auth/complete']);

/** /auth/complete?code=… (or ?error=…) on `origin`, or null if the params are missing/malformed. */
function authCompleteUrl(origin: string, query: string): string | null {
  const code = queryParam(query, 'code');
  if (code != null) return CODE_RE.test(code) ? `${origin}${AUTH_COMPLETE_PATH}?code=${encodeURIComponent(code)}` : null;
  const error = queryParam(query, 'error');
  const e = error && ERROR_RE.test(error) ? error : 'failed';
  return `${origin}${AUTH_COMPLETE_PATH}?error=${encodeURIComponent(e)}`;
}

export type LinkTarget = { url: string; kind: 'auth' | 'page'; code?: string };

/**
 * Map an incoming deep link / universal link / auth callback to the https page the WebView should open.
 * `currentUrl` (the page on screen) picks the origin, so the PKCE verifier in that origin's localStorage is found.
 */
export function resolveIncomingLink(raw: string, currentUrl?: string | null): LinkTarget | null {
  const u = parseUrl(raw);
  if (!u) return null;

  if (u.scheme === APP_SCHEME) {
    const origin = appOriginOf(currentUrl);
    // openlounge://auth?… → host "auth"; openlounge:///auth?… → path "/auth"
    const path = (u.host ? `/${u.host}` : '') + (u.path === '/' ? '' : u.path);
    if (AUTH_PATHS.has(path || '/')) {
      const url = authCompleteUrl(origin, u.query);
      return url ? { url, kind: 'auth', code: queryParam(u.query, 'code') ?? undefined } : null;
    }
    const target = (path || '/') + (u.query ? `?${u.query}` : '');
    return isSafeAppPath(target) ? { url: `${origin}${target}`, kind: 'page' } : { url: `${origin}/`, kind: 'page' };
  }

  if (u.scheme === 'https' && isAppUrl(raw)) {
    const origin = `https://${u.host}`;
    if (u.path === '/auth/exchange' || u.path === AUTH_COMPLETE_PATH) {
      const url = authCompleteUrl(origin, u.query);
      return url ? { url, kind: 'auth', code: queryParam(u.query, 'code') ?? undefined } : null;
    }
    return { url: raw, kind: 'page' };
  }
  return null;
}

/** OAuth start URL the app should open in ASWebAuthenticationSession (only our own /auth/<provider>/start?app=1). */
export function isNativeAuthStart(raw: string): boolean {
  const u = parseUrl(raw);
  if (!u || u.scheme !== 'https' || u.hasUserInfo || !isAppHost(u.host)) return false;
  return /^\/auth\/(google|apple)\/start$/.test(u.path) && queryParam(u.query, 'app') === '1';
}

