// HTTP routes for unified sign-in (Google, Apple, email+password, account linking, password reset).
// Every method ends in the SAME v2 session as phone login (store.createSession → access + rotating refresh token),
// so /auth/validate, /auth/refresh and /auth/logout behave exactly as before.
//
// Browser-navigation routes (no CORS; they answer with redirects):
//   GET  /auth/google/start[?app=1&cc=<S256 challenge>][&intent=<link intent>]   → 302 accounts.google.com
//   GET  /auth/google/callback?code&state                                         → 302 /auth/complete?code=… | openlounge://auth?code=…
//   GET  /auth/apple/start  (same query)                                          → 302 appleid.apple.com (response_mode=form_post)
//   POST /auth/apple/callback  (form_post from appleid.apple.com)                 → 303 /auth/complete?code=… | openlounge://auth?code=…
// JSON API (CORS allowlist as before):
//   GET  /auth/providers                         which buttons to show {phone,email,google,apple}
//   POST /auth/exchange {code, codeVerifier?}     one-time code → session | signup ticket | "linked"
//   POST /auth/email/signup {email,password}      always {ok:true} (verification link, or "you already have an account" mail)
//   POST /auth/email/verify {token}               verification link → session | signup ticket | linked | exists
//   POST /auth/email/login {email,password}       session, or a friendly "doesn't match"
//   POST /auth/password/forgot {email}            always {ok:true}
//   POST /auth/password/reset {token,password}    new password, every session of that user revoked
//   GET  /auth/identities                (Bearer) sign-in methods on my account
//   POST /auth/identities/remove {id}    (Bearer) detach one (never the last)
//   POST /auth/link/start {provider,app?}(Bearer) → {url} to start Google/Apple in "link to my account" mode
//   POST /auth/email/link {email,password}(Bearer) add email+password (after clicking the emailed link)

import type { IncomingMessage, ServerResponse } from "node:http";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { store, normalizeEmail } from "../store";
import { deriveKey, deviceLabel, sha256 } from "../auth";
import type { IdentityProvider } from "../persistence";
import { verifyIdToken, claimTrue } from "./jwt";
import { appleClientSecret, appleConfig, emailEnabled, endpoints, googleConfig, providerFlags, publicBaseUrl, redirectUri } from "./providers";
import { describeIdentities, linkToUser, parseIdentityId, resolveSignIn, type ExternalIdentity } from "./accounts";
import { dummyVerify, hashPassword, needsRehash, passwordProblem, verifyPassword } from "./password";
import { LIMITS, allow, peekAllowed } from "./ratelimit";
import { issueTicket } from "./signup";
import { alreadyRegisteredMail, resetPasswordMail, sendMail, verifyEmailMail } from "./mailer";

type OAuthProvider = "google" | "apple";
const isProd = () => process.env.NODE_ENV === "production";
/** Deep-link target for the native wrappers (fixed: never an open redirect). */
export const APP_RETURN = "openlounge://auth";

const RESET_TTL_MS = 30 * 60_000;
const VERIFY_TTL_MS = 24 * 60 * 60_000;
const EXCHANGE_TTL_MS = 5 * 60_000;
const INTENT_TTL_MS = 10 * 60_000;
const STATE_TTL_MS = 10 * 60_000;

// ---------- small HTTP helpers ----------

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string, status = 302, cookies: string[] = []) {
  res.writeHead(status, { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...(cookies.length ? { "Set-Cookie": cookies } : {}) });
  res.end();
}

async function readRaw(req: IncomingMessage, max = 16_000): Promise<string> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > max) break;
  }
  return raw;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req);
  const type = String(req.headers["content-type"] ?? "");
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/**
 * Client IP for rate limits. Behind Railway's edge the proxy appends the real client address to X-Forwarded-For, so
 * we count from the right (TRUST_PROXY_HOPS, default 1) — a client-supplied X-Forwarded-For can't pick its own bucket.
 */
export function clientIp(req: IncomingMessage): string {
  const hops = Math.max(0, Number(process.env.TRUST_PROXY_HOPS ?? 1) || 0);
  const chain = String(req.headers["x-forwarded-for"] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const ip = hops && chain.length ? chain[Math.max(0, chain.length - hops)] : req.socket.remoteAddress;
  return (ip || "unknown").replace(/^::ffff:/, "");
}

const bearer = (req: IncomingMessage) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
const str = (v: unknown, max = 500) => (typeof v === "string" ? v.slice(0, max) : "");
const tooMany = (res: ServerResponse) => json(res, 429, { ok: false, error: "Too many attempts. Please wait a few minutes and try again." });

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- one-time codes (hashed at rest) ----------

async function createCode(purpose: string, payload: unknown, ttlMs: number): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  const now = Date.now();
  await store.oneTime.put("code", { hash: sha256(code), purpose, payload, createdAt: now, expiresAt: now + ttlMs });
  return code;
}

async function consumeCode<T>(purpose: string, code: unknown): Promise<T | null> {
  if (typeof code !== "string" || code.length < 20 || code.length > 200) return null;
  const r = await store.oneTime.consume("code", sha256(code), purpose, Date.now());
  return (r?.payload as T) ?? null;
}

// ---------- sessions ----------

function sessionBody(userId: string, req: IncomingMessage, device: unknown) {
  const creds = store.createSession(userId, deviceLabel(device, req.headers["user-agent"]));
  return { ok: true, status: "existing", ...creds, user: store.me(userId), following: store.followingIds(userId), unreadDms: store.unreadDmCount(userId) };
}

async function authed(req: IncomingMessage) {
  const r = await store.authenticate(bearer(req));
  return r.ok ? r.userId : null;
}

// ---------- OAuth state cookie (AES-256-GCM sealed, httpOnly, 10 min, bound to this browser) ----------

interface OAuthState {
  p: OAuthProvider;
  /** state */
  s: string;
  /** PKCE verifier (Google) */
  v: string;
  /** nonce */
  n: string;
  /** where to return: web page or the native wrapper's deep link */
  m: "web" | "app";
  /** wrapper's S256 challenge for the exchange (binds the deep-linked code to the app that started) */
  cc: string | null;
  /** link mode: the signed-in user adding this provider */
  u: string | null;
  e: number;
}

function seal(st: OAuthState): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", deriveKey("oauth-state"), iv);
  c.setAAD(Buffer.from(st.p));
  const ct = Buffer.concat([c.update(JSON.stringify(st), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

function unseal(raw: string | undefined, p: OAuthProvider): OAuthState | null {
  if (!raw || raw.length > 4000) return null;
  try {
    const buf = Buffer.from(raw, "base64url");
    const d = createDecipheriv("aes-256-gcm", deriveKey("oauth-state"), buf.subarray(0, 12));
    d.setAAD(Buffer.from(p));
    d.setAuthTag(buf.subarray(12, 28));
    const st = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8")) as OAuthState;
    if (st.p !== p || st.e < Date.now()) return null;
    return st;
  } catch {
    return null;
  }
}

function stateCookie(p: OAuthProvider, value: string, req: IncomingMessage, maxAgeSec: number) {
  const https = publicBaseUrl(req.headers.host).startsWith("https://");
  // Apple returns with a cross-site POST (form_post): only SameSite=None cookies ride along (requires Secure/https).
  const sameSite = https ? (p === "apple" ? "None" : "Lax") : "Lax";
  return `ol_oauth_${p}=${value}; Path=/auth/${p}/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=${sameSite}${https ? "; Secure" : ""}`;
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function finish(res: ServerResponse, st: Pick<OAuthState, "m"> | null, q: { code?: string; error?: string }, cookies: string[], status = 302) {
  const params = new URLSearchParams(q.code ? { code: q.code } : { error: q.error ?? "failed" }).toString();
  redirect(res, st?.m === "app" ? `${APP_RETURN}?${params}` : `/auth/complete?${params}`, status, cookies);
}

async function oauthStart(p: OAuthProvider, req: IncomingMessage, res: ServerResponse, query: URLSearchParams) {
  const cfg = p === "google" ? googleConfig() : appleConfig();
  const mode: "web" | "app" = query.get("app") === "1" ? "app" : "web";
  if (!cfg) return finish(res, { m: mode }, { error: "unavailable" }, []);
  // The state cookie must be set on the host the provider will redirect back to.
  const base = publicBaseUrl(req.headers.host);
  const host = new URL(base).host;
  if (req.headers.host && req.headers.host.toLowerCase() !== host.toLowerCase()) return redirect(res, `${base}${req.url}`);
  if (!allow(`oauth:ip:${clientIp(req)}`, LIMITS.oauthStartIp)) return finish(res, { m: mode }, { error: "busy" }, []);

  let linkUser: string | null = null;
  const intent = query.get("intent");
  if (intent) {
    const payload = await consumeCode<{ userId: string; provider: string }>("link_intent", intent);
    if (!payload || payload.provider !== p || !store.users.has(payload.userId)) return finish(res, { m: mode }, { error: "expired" }, []);
    linkUser = payload.userId;
  }
  const cc = query.get("cc");
  const st: OAuthState = {
    p,
    s: randomBytes(24).toString("base64url"),
    v: randomBytes(48).toString("base64url"),
    n: randomBytes(24).toString("base64url"),
    m: mode,
    cc: cc && /^[\w-]{43,128}$/.test(cc) ? cc : null,
    u: linkUser,
    e: Date.now() + STATE_TTL_MS,
  };
  const ep = endpoints(p);
  const params = new URLSearchParams(
    p === "google"
      ? {
          client_id: (cfg as { clientId: string }).clientId,
          redirect_uri: redirectUri(p, req.headers.host),
          response_type: "code",
          scope: "openid email profile",
          state: st.s,
          nonce: st.n,
          code_challenge: createHash("sha256").update(st.v).digest("base64url"),
          code_challenge_method: "S256",
          prompt: "select_account",
        }
      : {
          client_id: (cfg as { servicesId: string }).servicesId,
          redirect_uri: redirectUri(p, req.headers.host),
          response_type: "code",
          response_mode: "form_post",
          scope: "name email",
          state: st.s,
          nonce: st.n,
        },
  );
  redirect(res, `${ep.authUrl}?${params}`, 302, [stateCookie(p, seal(st), req, STATE_TTL_MS / 1000)]);
}

async function exchangeCodeForIdToken(p: OAuthProvider, code: string, st: OAuthState, req: IncomingMessage): Promise<string> {
  const ep = endpoints(p);
  const body: Record<string, string> =
    p === "google"
      ? {
          code,
          client_id: googleConfig()!.clientId,
          client_secret: googleConfig()!.clientSecret,
          redirect_uri: redirectUri(p, req.headers.host),
          grant_type: "authorization_code",
          code_verifier: st.v,
        }
      : { code, client_id: appleConfig()!.servicesId, client_secret: appleClientSecret(), redirect_uri: redirectUri(p, req.headers.host), grant_type: "authorization_code" };
  const r = await fetch(ep.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await r.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!r.ok || typeof data.id_token !== "string") throw new Error(`token endpoint ${r.status}${data.error ? ` ${data.error}` : ""}`);
  return data.id_token;
}

/** Apple sends the name (and email) only the very first time someone authorizes the app, as a JSON form field. */
function appleUserHints(raw: unknown): { firstName: string; lastName: string } {
  try {
    const u = JSON.parse(str(raw, 2000) || "{}") as { name?: { firstName?: unknown; lastName?: unknown } };
    return { firstName: str(u.name?.firstName, 24).trim(), lastName: str(u.name?.lastName, 24).trim() };
  } catch {
    return { firstName: "", lastName: "" };
  }
}

async function oauthCallback(p: OAuthProvider, req: IncomingMessage, res: ServerResponse, params: Record<string, unknown>) {
  const clear = [stateCookie(p, "", req, 0)];
  const st = unseal(parseCookies(req)[`ol_oauth_${p}`], p);
  const status = req.method === "POST" ? 303 : 302;
  const fail = (error: string) => finish(res, st, { error }, clear, status);
  const err = str(params.error, 100);
  if (err) return fail(err === "access_denied" || err === "user_cancelled_authorize" ? "cancelled" : "failed");
  if (!st || !safeEqual(str(params.state, 200), st.s)) return fail("expired");
  if (!(p === "google" ? googleConfig() : appleConfig())) return fail("unavailable");
  const code = str(params.code, 2000);
  if (!code) return fail("failed");

  let ext: ExternalIdentity;
  let hints = { firstName: "", lastName: "" };
  try {
    const idToken = await exchangeCodeForIdToken(p, code, st, req);
    const ep = endpoints(p);
    const claims = await verifyIdToken(idToken, {
      jwksUrl: ep.jwksUrl,
      issuers: ep.issuers,
      audience: p === "google" ? googleConfig()!.clientId : appleConfig()!.servicesId,
      nonce: st.n,
    });
    const email = typeof claims.email === "string" ? claims.email : null;
    ext = { provider: p, subject: claims.sub, email, emailVerified: !!email && claimTrue(claims.email_verified) };
    if (p === "google") hints = { firstName: str(claims.given_name, 24), lastName: str(claims.family_name, 24) };
    else hints = appleUserHints(params.user);
  } catch (e) {
    console.warn(`[auth] ${p} sign-in failed: ${(e as Error).message}`); // never logs codes or tokens
    return fail("failed");
  }

  let payload: Record<string, unknown>;
  if (st.u) {
    const r = linkToUser(store, st.u, ext);
    if (!r.ok) return fail(r.code === "taken" ? "taken" : "failed");
    payload = { kind: "linked", provider: p };
  } else {
    const r = resolveSignIn(store, ext);
    payload =
      r.kind === "existing"
        ? { kind: "session", userId: r.userId, provider: p }
        : { kind: "signup", identity: r.identity, hints: { ...hints, email: r.identity.email } };
  }
  const oneTime = await createCode("exchange", { ...payload, cc: st.cc }, EXCHANGE_TTL_MS);
  finish(res, st, { code: oneTime }, clear, status);
}

// ---------- email ----------

async function emailSignup(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>, linkUserId: string | null) {
  if (!emailEnabled()) return json(res, 404, { ok: false, error: "Not found" });
  const email = normalizeEmail(body.email);
  if (!email) return json(res, 400, { ok: false, error: "Enter a valid email address." });
  const problem = passwordProblem(body.password);
  if (problem) return json(res, 400, { ok: false, error: problem });
  if (!allow(`signup:ip:${clientIp(req)}`, LIMITS.signupIp)) return tooMany(res);
  const base = publicBaseUrl(req.headers.host);
  const generic = { ok: true, sent: true };
  const existing = store.findIdentity("email", email);
  if (linkUserId && existing?.userId === linkUserId) return json(res, 400, { ok: false, error: "That email is already on your account." });
  // per-email budget: beyond it we quietly send nothing (the response is identical either way)
  if (!allow(`signup:email:${email}`, LIMITS.signupEmail)) return json(res, 200, generic);
  if (existing) {
    await sendMail(alreadyRegisteredMail(email, `${base}/?signin=email`, `${base}/forgot-password`));
    return json(res, 200, generic);
  }
  const passwordHash = await hashPassword(body.password as string);
  const token = await createCode("verify_email", { email, passwordHash, userId: linkUserId }, VERIFY_TTL_MS);
  await sendMail(verifyEmailMail(email, `${base}/verify-email?token=${token}`, !!linkUserId));
  json(res, 200, generic);
}

async function emailVerify(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) {
  if (!allow(`verify:ip:${clientIp(req)}`, LIMITS.exchangeIp)) return tooMany(res);
  const p = await consumeCode<{ email: string; passwordHash: string; userId: string | null }>("verify_email", body.token);
  if (!p) return json(res, 400, { ok: false, error: "That link has expired or was already used." });
  const existing = store.findIdentity("email", p.email);
  if (p.userId) {
    // Settings → add email + password
    if (!store.users.has(p.userId)) return json(res, 400, { ok: false, error: "That link has expired or was already used." });
    if (existing && existing.userId !== p.userId) return json(res, 409, { ok: false, error: "That email is already on another Open Lounge account." });
    const r = store.addIdentity(p.userId, { provider: "email", subject: p.email, email: p.email, verified: true });
    if (!r.ok) return json(res, 409, { ok: false, error: r.error });
    store.setPasswordHash(p.userId, p.passwordHash);
    return json(res, 200, { ok: true, status: "linked", provider: "email" });
  }
  if (existing) return json(res, 200, { ok: true, status: "exists", email: p.email });
  // the link proved the inbox → a verified email; same linking rules as Google/Apple
  const r = resolveSignIn(store, { provider: "email", subject: p.email, email: p.email, emailVerified: true });
  if (r.kind === "existing") {
    // (no email identity existed, so the account has no password yet — never overwrite one here)
    if (!store.passwordHashOf(r.userId)) store.setPasswordHash(r.userId, p.passwordHash);
    return json(res, 200, sessionBody(r.userId, req, body.device));
  }
  const ticket = issueTicket({ kind: "identity", identity: r.identity, passwordHash: p.passwordHash });
  json(res, 200, { ok: true, status: "new", ticket, profile: { firstName: "", lastName: "", email: p.email } });
}

async function emailLogin(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) {
  if (!emailEnabled()) return json(res, 404, { ok: false, error: "Not found" });
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) return json(res, 400, { ok: false, error: "Enter your email and password." });
  if (!allow(`login:ip:${clientIp(req)}`, LIMITS.loginIp) || !allow(`login:email:${email}`, LIMITS.loginEmail)) return tooMany(res);
  const ident = store.findIdentity("email", email);
  const hash = ident ? store.passwordHashOf(ident.userId) : null;
  if (!ident || !hash) {
    await dummyVerify(password);
    return json(res, 401, { ok: false, error: "That email and password don't match. Try again or reset your password." });
  }
  if (!(await verifyPassword(password, hash))) return json(res, 401, { ok: false, error: "That email and password don't match. Try again or reset your password." });
  if (needsRehash(hash)) store.setPasswordHash(ident.userId, await hashPassword(password));
  store.touchIdentity("email", email);
  json(res, 200, sessionBody(ident.userId, req, body.device));
}

async function forgotPassword(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) {
  const generic = { ok: true, sent: true };
  const email = normalizeEmail(body.email);
  if (!email) return json(res, 400, { ok: false, error: "Enter a valid email address." });
  if (!allow(`forgot:ip:${clientIp(req)}`, LIMITS.forgotIp)) return tooMany(res);
  if (!allow(`forgot:email:${email}`, LIMITS.forgotEmail)) return json(res, 200, generic);
  // the account: its email identity, else the one account with a verified Google/Apple identity on this email
  const userId = store.findIdentity("email", email)?.userId ?? store.userByVerifiedEmail(email);
  if (userId && store.users.has(userId)) {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    await store.flush(); // the reset row references users(id)
    await store.oneTime.put("reset", { hash: sha256(token), purpose: "reset", userId, email, createdAt: now, expiresAt: now + RESET_TTL_MS });
    await sendMail(resetPasswordMail(email, `${publicBaseUrl(req.headers.host)}/reset-password?token=${token}`, !!store.passwordHashOf(userId)));
  }
  json(res, 200, generic);
}

async function resetPassword(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) {
  const problem = passwordProblem(body.password);
  if (problem) return json(res, 400, { ok: false, error: problem });
  if (!allow(`reset:ip:${clientIp(req)}`, LIMITS.resetIp)) return tooMany(res);
  const token = str(body.token, 200);
  const bad = () => json(res, 400, { ok: false, error: "This reset link has expired or was already used. Request a new one." });
  if (token.length < 20) return bad();
  const hash = sha256(token);
  // per-email budget is checked against the address the link was sent to before the token is spent
  const peek = await store.oneTime.peekReset?.(hash, Date.now());
  if (peek && !peekAllowed(`reset:email:${peek.email}`, LIMITS.resetEmail)) return tooMany(res);
  const row = await store.oneTime.consume("reset", hash, "reset", Date.now());
  if (!row?.userId || !store.users.has(row.userId)) return bad();
  allow(`reset:email:${row.email}`, LIMITS.resetEmail);
  const userId = row.userId;
  store.setPasswordHash(userId, await hashPassword(body.password as string));
  if (row.email && !store.findIdentity("email", row.email)) store.addIdentity(userId, { provider: "email", subject: row.email, email: row.email, verified: true });
  await store.oneTime.supersedeResets(userId, Date.now());
  const revoked = store.revokeSession(undefined, { allForUser: userId });
  console.log(`[auth] password reset for ${userId}: ${revoked.length} session(s) revoked`);
  json(res, 200, { ok: true, email: row.email });
}

// ---------- router ----------

/** Paths handled here (both /auth/* and /api/auth/*). */
export const UNIFIED_AUTH_PATH =
  /^\/(?:api\/)?auth\/(providers|exchange|identities|identities\/remove|link\/start|email\/(?:signup|login|verify|link)|password\/(?:forgot|reset)|(?:google|apple)\/(?:start|callback))$/;

/** Top-level browser navigations (redirect responses; not subject to the CORS check — Apple posts from appleid.apple.com). */
export function isNavigationRoute(path: string) {
  return /^\/auth\/(google|apple)\/(start|callback)$/.test(path);
}

export async function handleNavigation(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) {
  const m = /^\/auth\/(google|apple)\/(start|callback)$/.exec(path)!;
  const p = m[1] as OAuthProvider;
  if (m[2] === "start" && req.method === "GET") return oauthStart(p, req, res, query);
  if (m[2] === "callback" && p === "google" && req.method === "GET") return oauthCallback(p, req, res, Object.fromEntries(query));
  if (m[2] === "callback" && p === "apple" && req.method === "POST") return oauthCallback(p, req, res, await readBody(req));
  json(res, 405, { ok: false, error: "Method not allowed" });
}

/** JSON routes (called after the CORS check). Returns false if the path isn't one of ours. */
export async function handleAuthApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const route = path.replace(/^\/api\//, "/");
  const method = req.method;
  if (route === "/auth/providers" && method === "GET") {
    json(res, 200, { ok: true, providers: providerFlags() });
    return true;
  }
  if (method !== "POST" && !(route === "/auth/identities" && method === "GET")) return false;

  if (route === "/auth/identities") {
    const userId = await authed(req);
    if (!userId) return json(res, 401, { ok: false, reason: "invalid" }), true;
    json(res, 200, { ok: true, identities: describeIdentities(store, userId), hasPassword: !!store.passwordHashOf(userId), providers: providerFlags() });
    return true;
  }
  const body = await readBody(req);
  switch (route) {
    case "/auth/exchange": {
      if (!allow(`exchange:ip:${clientIp(req)}`, LIMITS.exchangeIp)) return tooMany(res), true;
      const p = await consumeCode<{ kind: string; userId?: string; provider?: string; identity?: never; hints?: Record<string, string>; cc?: string | null }>("exchange", body.code);
      const expired = () => json(res, 400, { ok: false, error: "That sign-in took too long. Please try again." });
      if (!p) return expired(), true;
      if (p.cc) {
        // code came back through a deep link: only the app that started the flow (holder of the verifier) may redeem it
        const v = str(body.codeVerifier, 200);
        if (!v || !safeEqual(createHash("sha256").update(v).digest("base64url"), p.cc)) return expired(), true;
      }
      if (p.kind === "session" && p.userId && store.users.has(p.userId)) return json(res, 200, { ...sessionBody(p.userId, req, body.device), provider: p.provider }), true;
      if (p.kind === "signup" && p.identity) {
        const ticket = issueTicket({ kind: "identity", identity: p.identity });
        return json(res, 200, { ok: true, status: "new", ticket, profile: p.hints ?? {}, provider: (p.identity as { provider: string }).provider }), true;
      }
      if (p.kind === "linked") return json(res, 200, { ok: true, status: "linked", provider: p.provider }), true;
      return expired(), true;
    }
    case "/auth/email/signup":
      return await emailSignup(req, res, body, null), true;
    case "/auth/email/verify":
      return await emailVerify(req, res, body), true;
    case "/auth/email/login":
      return await emailLogin(req, res, body), true;
    case "/auth/password/forgot":
      return await forgotPassword(req, res, body), true;
    case "/auth/password/reset":
      return await resetPassword(req, res, body), true;
    case "/auth/email/link": {
      const userId = await authed(req);
      if (!userId) return json(res, 401, { ok: false, reason: "invalid" }), true;
      return await emailSignup(req, res, body, userId), true;
    }
    case "/auth/link/start": {
      const userId = await authed(req);
      if (!userId) return json(res, 401, { ok: false, reason: "invalid" }), true;
      const p = body.provider === "google" || body.provider === "apple" ? (body.provider as OAuthProvider) : null;
      if (!p || !providerFlags()[p]) return json(res, 400, { ok: false, error: "That sign-in method isn't available." }), true;
      const intent = await createCode("link_intent", { userId, provider: p }, INTENT_TTL_MS);
      const q = new URLSearchParams({ intent, ...(body.app === true ? { app: "1" } : {}), ...(typeof body.cc === "string" ? { cc: body.cc } : {}) });
      return json(res, 200, { ok: true, url: `/auth/${p}/start?${q}` }), true;
    }
    case "/auth/identities/remove": {
      const userId = await authed(req);
      if (!userId) return json(res, 401, { ok: false, reason: "invalid" }), true;
      const id = parseIdentityId(body.id);
      if (!id) return json(res, 400, { ok: false, error: "That sign-in method isn't on your account." }), true;
      const r = store.removeIdentity(userId, id.provider as IdentityProvider, id.subject);
      return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, identities: describeIdentities(store, userId) } : r), true;
    }
  }
  return false;
}
