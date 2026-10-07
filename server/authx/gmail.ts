// Gmail API transport (HTTPS, no SMTP): users.messages.send with a raw RFC 2822 message (base64url),
// authenticated by an OAuth2 refresh token. Used where outbound SMTP is blocked (Railway non-Pro plans).
// Env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_SENDER (the Gmail address; also the From).
// Optional: MAIL_REPLY_TO, GMAIL_DAILY_LIMIT (local safety cap, default 450 — consumer Gmail allows ~500 recipients/day).
// Never logs tokens, secrets, or message bodies.

import { randomBytes } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export class GmailSendError extends Error {
  constructor(message: string, readonly kind: "auth" | "quota" | "other", readonly status?: number) {
    super(message);
  }
}

let token: { value: string; exp: number; key: string } | null = null;
let blockedUntil = 0; // quota cool-down
let day = "";
let sentToday = 0;

/** test hook */
export function _resetGmailState() {
  token = null;
  blockedUntil = 0;
  day = "";
  sentToday = 0;
}

const env = (k: string) => (process.env[k] ?? "").trim();

async function accessToken(): Promise<string> {
  const id = env("GMAIL_CLIENT_ID"), secret = env("GMAIL_CLIENT_SECRET"), refresh = env("GMAIL_REFRESH_TOKEN");
  const key = `${id}:${refresh.length}:${refresh.slice(-6)}`;
  if (token && token.key === key && token.exp > Date.now() + 60_000) return token.value;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(10_000),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !j.access_token) {
    token = null;
    const hint = j.error === "invalid_grant"
      ? " — the refresh token was revoked or expired (OAuth apps in 'Testing' mode issue tokens that expire after 7 days; publish the app and re-run scripts/gmail-oauth.mjs)"
      : "";
    throw new GmailSendError(`Gmail OAuth token refresh failed (${res.status} ${j.error ?? "error"})${hint}`, "auth", res.status);
  }
  token = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000, key };
  return token.value;
}

// ---------- RFC 2822 ----------

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const wrap = (s: string) => s.replace(/.{1,76}/g, "$&\r\n");
/** RFC 2047 encoded-word for non-ASCII header values */
const hdr = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const noCrlf = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export function buildRawMessage(m: { from: string; fromName?: string; to: string; replyTo?: string; subject: string; text: string; html: string }): string {
  const boundary = `ol_${randomBytes(12).toString("hex")}`;
  const domain = m.from.split("@")[1] || "localhost";
  const lines = [
    `From: ${m.fromName ? `"${hdr(noCrlf(m.fromName)).replace(/"/g, "")}" ` : ""}<${noCrlf(m.from)}>`,
    `To: <${noCrlf(m.to)}>`,
    ...(m.replyTo ? [`Reply-To: <${noCrlf(m.replyTo)}>`] : []),
    `Subject: ${hdr(noCrlf(m.subject))}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomBytes(16).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap(b64(m.text)),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap(b64(m.html)),
    `--${boundary}--`,
    "",
  ];
  return lines.join("\r\n");
}

export const base64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

// ---------- send ----------

const QUOTA_REASONS = /dailyLimitExceeded|userRateLimitExceeded|rateLimitExceeded|quotaExceeded|sending limit/i;

export async function gmailSend(m: { to: string; subject: string; text: string; html: string }): Promise<void> {
  const now = Date.now();
  if (now < blockedUntil) throw new GmailSendError(`Gmail sending paused after a quota error until ${new Date(blockedUntil).toISOString()}`, "quota");
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; sentToday = 0; }
  const cap = Number(env("GMAIL_DAILY_LIMIT") || 450);
  if (sentToday >= cap) throw new GmailSendError(`Gmail local daily cap reached (${cap}/day; consumer Gmail allows ~500 recipients/day) — raise GMAIL_DAILY_LIMIT only on Google Workspace`, "quota");

  const sender = env("GMAIL_SENDER");
  const raw = buildRawMessage({ from: sender, fromName: "Open Lounge", to: m.to, replyTo: env("MAIL_REPLY_TO") || undefined, subject: m.subject, text: m.text, html: m.html });
  const send = async () =>
    fetch(SEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: base64url(raw) }),
      signal: AbortSignal.timeout(15_000),
    });
  let res = await send();
  if (res.status === 401) { token = null; res = await send(); } // stale access token
  if (res.ok) { sentToday++; return; }
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; errors?: { reason?: string }[] } };
  const reasons = (body.error?.errors ?? []).map((e) => e.reason).filter(Boolean).join(",");
  const msg = `${body.error?.message ?? ""} ${reasons}`;
  if (res.status === 429 || (res.status === 403 && QUOTA_REASONS.test(msg)) || QUOTA_REASONS.test(msg)) {
    const daily = /daily|sending limit/i.test(msg);
    blockedUntil = Date.now() + (daily ? 60 : 5) * 60_000;
    throw new GmailSendError(`Gmail quota exceeded (${res.status} ${reasons || "rate limit"})${daily ? " — daily sending limit (~500/day on consumer Gmail); pausing 60 min" : "; pausing 5 min"}`, "quota", res.status);
  }
  throw new GmailSendError(`Gmail API send failed (${res.status} ${reasons || body.error?.message || "error"})`, res.status === 401 || res.status === 403 ? "auth" : "other", res.status);
}
