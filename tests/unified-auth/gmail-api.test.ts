// Gmail API transport with a mocked fetch: token refresh + caching, raw RFC 2822 message, transport selection,
// quota/auth error handling. No network.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const ENV = process.env as Record<string, string | undefined>;
ENV.NODE_ENV = "test";
delete process.env.DATABASE_URL;

const realFetch = globalThis.fetch;
type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
function mockFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const okHandler = (url: string) =>
  url.includes("oauth2") ? { status: 200, body: { access_token: "at-1", expires_in: 3600 } } : { status: 200, body: { id: "m1" } };

function setGmailEnv() {
  for (const k of ["SMTP_HOST", "SMTP_FROM", "MAIL_TRANSPORT", "MAIL_REPLY_TO", "GMAIL_DAILY_LIMIT"]) delete ENV[k];
  Object.assign(ENV, { GMAIL_CLIENT_ID: "cid", GMAIL_CLIENT_SECRET: "csecret", GMAIL_REFRESH_TOKEN: "rtok-abcdef", GMAIL_SENDER: "openlounge.app@gmail.com" });
}

beforeEach(async () => {
  calls = [];
  setGmailEnv();
  (await import("../../server/authx/gmail"))._resetGmailState();
});
test.after(() => { globalThis.fetch = realFetch; });

function decodeRaw(c: Call) {
  const raw = JSON.parse(String(c.init.body)).raw as string;
  assert.match(raw, /^[A-Za-z0-9_-]+$/, "base64url, no padding");
  return Buffer.from(raw, "base64url").toString("utf8");
}

test("transport selection: MAIL_TRANSPORT, auto, emailEnabled", async () => {
  const p = await import("../../server/authx/providers");
  assert.equal(p.mailTransport(), "gmail_api");
  ENV.MAIL_TRANSPORT = "smtp";
  assert.equal(p.mailTransport(), null, "smtp forced but not configured");
  Object.assign(ENV, { SMTP_HOST: "smtp.example.com", SMTP_FROM: "x@example.com" });
  assert.equal(p.mailTransport(), "smtp");
  ENV.MAIL_TRANSPORT = "gmail_api";
  assert.equal(p.mailTransport(), "gmail_api");
  delete ENV.GMAIL_REFRESH_TOKEN;
  assert.equal(p.mailTransport(), null);
  delete ENV.MAIL_TRANSPORT;
  assert.equal(p.mailTransport(), "smtp", "auto falls back to smtp");
  const prev = ENV.NODE_ENV;
  ENV.NODE_ENV = "production";
  setGmailEnv();
  assert.equal(p.emailEnabled(), true, "production email on with Gmail API only");
  for (const k of ["GMAIL_CLIENT_ID"]) delete ENV[k];
  assert.equal(p.emailEnabled(), false);
  ENV.NODE_ENV = prev;
});

test("sendMail via Gmail API: token refresh, raw message, From/Reply-To, code not in subject", async () => {
  mockFetch(okHandler);
  ENV.MAIL_REPLY_TO = "help@openlounge.app";
  const { sendMail, emailCodeMail } = await import("../../server/authx/mailer");
  const ok = await sendMail(emailCodeMail("Ann@Example.com", "482913", false));
  assert.equal(ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  const form = new URLSearchParams(String(calls[0].init.body));
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), "rtok-abcdef");
  assert.equal(calls[1].url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.equal((calls[1].init.headers as Record<string, string>).authorization, "Bearer at-1");
  const msg = decodeRaw(calls[1]);
  assert.match(msg, /^From: "Open Lounge" <openlounge\.app@gmail\.com>\r\n/m);
  assert.match(msg, /^To: <Ann@Example\.com>\r$/m);
  assert.match(msg, /^Reply-To: <help@openlounge\.app>\r$/m);
  const subject = /^Subject: (.*)\r$/m.exec(msg)![1];
  assert.equal(subject, "Your Open Lounge sign-in code");
  assert.doesNotMatch(subject, /482913/);
  assert.match(msg, /multipart\/alternative/);
  const parts = [...msg.matchAll(/base64\r\n\r\n([\s\S]*?)\r\n--/g)].map((m) => Buffer.from(m[1].replace(/\r\n/g, ""), "base64").toString("utf8"));
  assert.equal(parts.length, 2);
  assert.match(parts[0], /Your code: 482913/);
  assert.match(parts[1], /<html/);

  // access token cached
  await sendMail(emailCodeMail("b@example.com", "111111", true));
  assert.equal(calls.length, 3);
});

test("non-ASCII subject is RFC 2047 encoded; header injection stripped", async () => {
  const { buildRawMessage } = await import("../../server/authx/gmail");
  const raw = buildRawMessage({ from: "a@gmail.com", fromName: "Open Lounge", to: "x@y.z\r\nBcc: evil@x.com", subject: "Héllo\r\nBcc: e@x", text: "t", html: "h" });
  assert.match(raw, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r$/m);
  assert.doesNotMatch(raw, /^Bcc:/m);
});

test("quota error: clear message, cool-down, sendMail returns false without throwing", async () => {
  mockFetch((url) => url.includes("oauth2") ? okHandler(url)
    : { status: 403, body: { error: { code: 403, message: "Daily user sending limit exceeded.", errors: [{ reason: "dailyLimitExceeded" }] } } });
  const { gmailSend, GmailSendError } = await import("../../server/authx/gmail");
  await assert.rejects(gmailSend({ to: "a@b.c", subject: "s", text: "t", html: "h" }), (e: unknown) =>
    e instanceof GmailSendError && e.kind === "quota" && /daily sending limit/.test(e.message));
  const n = calls.length;
  await assert.rejects(gmailSend({ to: "a@b.c", subject: "s", text: "t", html: "h" }), /paused/);
  assert.equal(calls.length, n, "no request during cool-down");
  const { sendMail } = await import("../../server/authx/mailer");
  assert.equal(await sendMail({ to: "a@b.c", subject: "s", text: "t", html: "h" }), false);
});

test("local daily cap", async () => {
  mockFetch(okHandler);
  ENV.GMAIL_DAILY_LIMIT = "2";
  const { gmailSend } = await import("../../server/authx/gmail");
  const m = { to: "a@b.c", subject: "s", text: "t", html: "h" };
  await gmailSend(m);
  await gmailSend(m);
  await assert.rejects(gmailSend(m), /daily cap reached/);
});

test("invalid_grant explains testing-mode expiry; 401 retries with a fresh token", async () => {
  mockFetch((url) => url.includes("oauth2") ? { status: 400, body: { error: "invalid_grant" } } : { status: 200, body: {} });
  const { gmailSend } = await import("../../server/authx/gmail");
  await assert.rejects(gmailSend({ to: "a@b.c", subject: "s", text: "t", html: "h" }), (e: Error) => /invalid_grant/.test(e.message) && /7 days/.test(e.message) && !/csecret|rtok/.test(e.message));

  (await import("../../server/authx/gmail"))._resetGmailState();
  calls = [];
  let sends = 0, tokens = 0;
  mockFetch((url) => {
    if (url.includes("oauth2")) return { status: 200, body: { access_token: `at-${++tokens}`, expires_in: 3600 } };
    return ++sends === 1 ? { status: 401, body: { error: { message: "Invalid Credentials" } } } : { status: 200, body: {} };
  });
  await gmailSend({ to: "a@b.c", subject: "s", text: "t", html: "h" });
  assert.equal(tokens, 2);
  assert.equal(sends, 2);
});
