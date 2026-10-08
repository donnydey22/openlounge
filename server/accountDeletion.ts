// Store compliance: Telegram-style account deletion (App Store 5.1.1(v), Google Play data deletion).
//
//   GET  /api/me/delete/options        which re-verification methods this account can use
//   POST /api/me/delete/email/start    { email }                 6-digit code to one of the account's verified emails
//   POST /api/me/delete/verify         { method, ... }           → { reauth } short-lived proof (10 min, single use)
//        method "password" { password } · "email" { email, code } · "phone" { idToken } (Firebase phone ID token for
//        the account's own number) · "recent" (signed in < 10 min ago, e.g. right after Google/Apple sign-in) ·
//        "device" (biometric/passcode checked by the phone app; app sessions only)
//   POST /api/me/delete                { confirm: "DELETE", reauth } → tombstone + PII scrub (store.deleteAccount),
//        push data (tokens, prefs, contact hashes), feature hooks (store.onAccountDeleted), live broadcast.
//
// Every display of a deleted member goes through store.publicUser() → deletedPublicUser() ("Deleted Account", ghost
// avatar, deleted: true). Open clients get `user:deleted { userId, user }` over the WebSocket.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { store } from "./store";
import { WsHub } from "./ws";
import { log } from "./log";
import { verifyPassword } from "./authx/password";
import { layout, maskEmail, sendMail } from "./authx/mailer";
import { verifyPhoneIdToken } from "./firebase";
import { maskPhone } from "./otp";

const REAUTH_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 10 * 60_000;
const RECENT_SIGNIN_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;

type Reauth = { userId: string; method: string; expiresAt: number };
const reauths = new Map<string, Reauth>();
const codes = new Map<string, { email: string; hash: string; expiresAt: number; attempts: number; sentAt: number }>();
const attempts = new Map<string, number[]>();
const key = randomBytes(32);
const h = (s: string) => createHmac("sha256", key).update(s).digest("hex");

function limited(k: string, max: number, windowMs: number) {
  const now = Date.now();
  const list = (attempts.get(k) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  attempts.set(k, list);
  return list.length > max;
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of reauths) if (v.expiresAt < now) reauths.delete(k);
  for (const [k, v] of codes) if (v.expiresAt < now) codes.delete(k);
}

function sessionOf(sessionId: string) {
  for (const s of store.sessions.values()) if (s.id === sessionId) return s;
  return null;
}

function verifiedEmails(userId: string) {
  return store.identitiesOf(userId).filter((i) => i.verified && i.email).map((i) => i.email!.toLowerCase());
}

function phoneOf(userId: string) {
  return store.identitiesOf(userId).find((i) => i.provider === "phone")?.subject ?? store.users.get(userId)?.phone ?? null;
}

export function deletionOptions(userId: string, sessionId: string) {
  const s = sessionOf(sessionId);
  const recent = !!s && Date.now() - s.createdAt < RECENT_SIGNIN_MS;
  const appSession = !!s && /^(android|ios)-app$/.test(s.device ?? "");
  const phone = phoneOf(userId);
  return {
    password: !!store.passwordHashOf(userId),
    emails: verifiedEmails(userId).map((e) => ({ email: e, masked: maskEmail(e) })),
    phone: phone ? { masked: maskPhone(phone) } : null,
    recent,
    device: appSession,
    providers: [...new Set(store.identitiesOf(userId).map((i) => i.provider))],
  };
}

function issue(userId: string, method: string) {
  sweep();
  const token = randomBytes(24).toString("base64url");
  reauths.set(h(token), { userId, method, expiresAt: Date.now() + REAUTH_TTL_MS });
  return token;
}

/** consume a reauth proof for this user (single use) */
export function consumeReauth(userId: string, token: unknown): Reauth | null {
  if (typeof token !== "string" || token.length < 16 || token.length > 100) return null;
  const k = h(token);
  const r = reauths.get(k);
  if (!r || r.userId !== userId || r.expiresAt < Date.now()) return null;
  reauths.delete(k);
  return r;
}

export async function startEmailCode(userId: string, email: unknown) {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!verifiedEmails(userId).includes(e)) return { ok: false as const, status: 400, error: "That email isn't verified on your account." };
  const prev = codes.get(userId);
  if (prev && Date.now() - prev.sentAt < 30_000) return { ok: false as const, status: 429, error: "Please wait a moment before requesting another code." };
  if (limited(`delcode:${userId}`, 5, 60 * 60_000)) return { ok: false as const, status: 429, error: "Too many codes requested. Try again later." };
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  codes.set(userId, { email: e, hash: h(`${userId}:${code}`), expiresAt: Date.now() + CODE_TTL_MS, attempts: 0, sentAt: Date.now() });
  const { html, text } = layout({
    preheader: "Your code to confirm deleting your Open Lounge account.",
    title: "Confirm account deletion",
    lead: "Open Lounge",
    intro: "Someone (hopefully you) asked to permanently delete your Open Lounge account. Enter this code to confirm it's you.",
    code,
    codeNote: "It expires in 10 minutes.",
    outro: "If you didn't ask for this, ignore this email and consider changing your password. Never share this code.",
  });
  await sendMail({ to: e, subject: "Your Open Lounge account deletion code", html, text, code });
  return { ok: true as const, sent: true, masked: maskEmail(e) };
}

export async function verify(userId: string, sessionId: string, body: Record<string, unknown>) {
  if (limited(`delverify:${userId}`, 10, 15 * 60_000)) return { ok: false as const, status: 429, error: "Too many attempts. Please wait a few minutes." };
  const method = String(body.method ?? "");
  const opts = deletionOptions(userId, sessionId);
  if (method === "password") {
    if (!opts.password) return { ok: false as const, status: 400, error: "Your account doesn't have a password." };
    if (!(await verifyPassword(body.password, store.passwordHashOf(userId)))) return { ok: false as const, status: 401, error: "That password isn't right." };
  } else if (method === "email") {
    const c = codes.get(userId);
    const code = String(body.code ?? "").replace(/\s/g, "");
    if (!c || c.expiresAt < Date.now()) return { ok: false as const, status: 400, error: "That code expired. Request a new one." };
    c.attempts++;
    const a = Buffer.from(h(`${userId}:${code}`)), b = Buffer.from(c.hash);
    if (!/^\d{6}$/.test(code) || a.length !== b.length || !timingSafeEqual(a, b)) {
      if (c.attempts >= MAX_ATTEMPTS) codes.delete(userId);
      return { ok: false as const, status: 401, error: "That code isn't right.", attemptsLeft: Math.max(0, MAX_ATTEMPTS - c.attempts) };
    }
    codes.delete(userId);
  } else if (method === "phone") {
    const phone = phoneOf(userId);
    if (!phone) return { ok: false as const, status: 400, error: "Your account doesn't have a phone number." };
    const v = await verifyPhoneIdToken(String(body.idToken ?? ""));
    if (!v.ok) return { ok: false as const, status: 401, error: v.error };
    if (v.phone !== phone) return { ok: false as const, status: 401, error: "That isn't the phone number on your account." };
  } else if (method === "recent") {
    if (!opts.recent) return { ok: false as const, status: 401, error: "Sign out and sign back in, then delete within 10 minutes." };
  } else if (method === "device") {
    if (!opts.device) return { ok: false as const, status: 400, error: "Face ID / fingerprint confirmation is only available in the Open Lounge app." };
  } else return { ok: false as const, status: 400, error: "Choose how to confirm it's you." };
  return { ok: true as const, reauth: issue(userId, method), expiresIn: REAUTH_TTL_MS / 1000 };
}

type PushCleanup = { deleteUserData(userId: string): Promise<void> } | null | undefined;

/** The deletion itself. Order: push data → tombstone + scrub (store) → durable flush → live broadcast. */
export async function deleteNow(userId: string, push: PushCleanup) {
  if (push) await push.deleteUserData(userId);
  const r = store.deleteAccount(userId);
  if (!r.ok) return r;
  await store.flush().catch(() => {});
  WsHub.latest?.emit("user:deleted", { userId, user: store.deletedPublicUser(userId) });
  log.info("account deleted", { userId, revokedSessions: r.revokedSessions });
  return r;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
};

/** HTTP routes under /api/me/delete*. Returns true if handled. `auth` = store.authenticate result. */
export async function handleDeletionApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  auth: { ok: true; userId: string; sessionId: string },
  body: () => Promise<Record<string, unknown>>,
  push: PushCleanup,
): Promise<boolean> {
  const uid = auth.userId;
  if (url === "/api/me/delete/options" && req.method === "GET") return json(res, 200, { ok: true, ...deletionOptions(uid, auth.sessionId) }), true;
  if (url === "/api/me/delete/email/start" && req.method === "POST") {
    const r = await startEmailCode(uid, (await body()).email);
    return json(res, r.ok ? 200 : r.status, r.ok ? r : { ok: false, error: r.error }), true;
  }
  if (url === "/api/me/delete/verify" && req.method === "POST") {
    const r = await verify(uid, auth.sessionId, await body());
    return json(res, r.ok ? 200 : r.status, r.ok ? r : { ok: false, error: r.error, ...("attemptsLeft" in r ? { attemptsLeft: r.attemptsLeft } : {}) }), true;
  }
  if (url === "/api/me/delete" && (req.method === "POST" || req.method === "DELETE")) {
    const b = await body();
    if (b?.confirm !== "DELETE") return json(res, 400, { ok: false, error: 'Confirmation required: send { "confirm": "DELETE" }' }), true;
    if (!consumeReauth(uid, b.reauth)) return json(res, 403, { ok: false, reauthRequired: true, error: "Please confirm it's you first." }), true;
    const r = await deleteNow(uid, push);
    if (!r.ok) return json(res, r.status, { ok: false, error: r.error }), true;
    return json(res, 200, { ok: true }), true;
  }
  return false;
}
