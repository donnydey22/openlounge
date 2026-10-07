// Email sign-in with a 6-digit code + Settings "add email" (real HTTP API over local Postgres, in-memory outbox).
// Run: npm run test:auth
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTestEnv, startApp, startMockProviders, wipeDb, sql, api, phoneLogin, registerTicket, oauthRoundTrip, type App, type MockProviders } from "./harness";

const keys = setTestEnv({ providers: true })!;
let app: App;
let mock: MockProviders;
let outbox: { to: string; subject: string; text: string; html: string; code?: string; link?: string }[];
let resetRateLimits: () => void;

const uniq = () => randomBytes(4).toString("hex");
const phoneNo = () => `+1415${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
const lastCode = (to: string) => [...outbox].reverse().find((m) => m.to === to && m.code)?.code ?? null;
/** let the resend cooldown pass without waiting 60s */
const skipCooldown = (email: string) => sql("UPDATE email_otp_codes SET created_at = created_at - 61000 WHERE email = $1", [email]);
const wrong = (c: string) => String((Number(c) + 1) % 1_000_000).padStart(6, "0");

before(async () => {
  await wipeDb();
  mock = await startMockProviders({
    googleClientId: process.env.GOOGLE_CLIENT_ID!,
    googleSecret: process.env.GOOGLE_CLIENT_SECRET!,
    appleServicesId: process.env.APPLE_SERVICES_ID!,
    appleTeamId: process.env.APPLE_TEAM_ID!,
    appleKeyId: process.env.APPLE_KEY_ID!,
    applePublicKey: keys.applePublicKey,
  });
  const providers = await import("../../server/authx/providers");
  providers.__setProviderEndpoints({
    google: { authUrl: `${mock.url}/google/auth`, tokenUrl: `${mock.url}/google/token`, jwksUrl: `${mock.url}/google/jwks`, issuers: ["https://accounts.google.com", "accounts.google.com"] },
    apple: { authUrl: `${mock.url}/apple/auth`, tokenUrl: `${mock.url}/apple/token`, jwksUrl: `${mock.url}/apple/jwks`, issuers: ["https://appleid.apple.com"] },
  });
  outbox = (await import("../../server/authx/mailer")).outbox;
  resetRateLimits = (await import("../../server/authx/ratelimit")).resetRateLimits;
  app = await startApp();
});

after(async () => {
  await app?.close();
  await mock?.close();
});

beforeEach(() => resetRateLimits());

test("new email → code → signup ticket → onboarding; next code signs into the same account", async () => {
  const email = `Otp_${uniq()}@Example.com`;
  const lc = email.toLowerCase();
  const s = await api(app.base, "/auth/email/code/start", { email });
  assert.equal(s.status, 200);
  assert.equal(s.data.resendIn, 60);
  const code = lastCode(lc)!;
  assert.match(code, /^\d{6}$/);
  const mail = [...outbox].reverse().find((m) => m.to === lc)!;
  assert.ok(mail.text.includes(code) && mail.html.includes(code));
  assert.ok(!mail.subject.includes(code), "code never in the subject (subjects are logged)");
  // stored hashed, never in clear
  const rows = await sql<{ code_hash: string; attempts: number; expires_at: string; created_at: string }>("SELECT * FROM email_otp_codes WHERE email = $1", [lc]);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].code_hash, code);
  assert.ok(!rows[0].code_hash.includes(code));
  assert.equal(Number(rows[0].expires_at) - Number(rows[0].created_at), 10 * 60_000);

  const v = await api(app.base, "/auth/email/code/verify", { email, code });
  assert.equal(v.status, 200);
  assert.equal(v.data.status, "new");
  assert.ok(v.data.ticket && v.data.linkCode);
  assert.equal(v.data.profile.email, lc);
  // single use
  assert.equal((await api(app.base, "/auth/email/code/verify", { email, code })).status, 400);

  const reg = await registerTicket(app.wsUrl, v.data.ticket, { firstName: "Olive", username: `olive_${uniq()}` });
  assert.equal(reg.res.ok, true);
  const uid = reg.res.user.id;
  reg.client.close();
  await (await import("../../server/store")).store.flush();
  const ident = await sql<{ verified: boolean; user_id: string }>("SELECT verified, user_id FROM auth_identities WHERE provider = 'email' AND provider_subject = $1", [lc]);
  assert.deepEqual(ident.map((i) => [i.user_id, i.verified]), [[uid, true]]);

  await skipCooldown(lc);
  await api(app.base, "/auth/email/code/start", { email: lc });
  const again = await api(app.base, "/auth/email/code/verify", { email: lc, code: lastCode(lc) });
  assert.equal(again.status, 200);
  assert.equal(again.data.status, "existing");
  assert.equal(again.data.user.id, uid);
  const val = await api(app.base, "/auth/validate", undefined, { token: again.data.access });
  assert.equal(val.status, 200);
  assert.equal(val.data.user.id, uid);
});

test("verified email of an existing Google account → the code signs into THAT account (links email)", async () => {
  const email = `gee_${uniq()}@gmail.com`;
  const first = await oauthRoundTrip(app, mock, "google", { sub: "g-" + uniq(), email, email_verified: true, given_name: "Gee" });
  assert.equal(first.stage, "exchange");
  if (first.stage !== "exchange") return;
  const reg = await registerTicket(app.wsUrl, first.exchange.data.ticket, { firstName: "Gee", username: `gee_${uniq()}` });
  const uid = reg.res.user.id;
  reg.client.close();
  await api(app.base, "/auth/email/code/start", { email });
  const v = await api(app.base, "/auth/email/code/verify", { email, code: lastCode(email) });
  assert.equal(v.data.status, "existing");
  assert.equal(v.data.user.id, uid);
});

test("unverified email elsewhere never links: Google with email_verified=false → new account", async () => {
  const email = `unv_${uniq()}@gmail.com`;
  const first = await oauthRoundTrip(app, mock, "google", { sub: "g-" + uniq(), email, email_verified: false, given_name: "Una" });
  if (first.stage !== "exchange") return assert.fail("exchange");
  const reg = await registerTicket(app.wsUrl, first.exchange.data.ticket, { firstName: "Una", username: `una_${uniq()}` });
  reg.client.close();
  await api(app.base, "/auth/email/code/start", { email });
  const v = await api(app.base, "/auth/email/code/verify", { email, code: lastCode(email) });
  assert.equal(v.data.status, "new");
});

test("max 5 attempts, then the code is dead even if correct; a new code works", async () => {
  const email = `att_${uniq()}@example.com`;
  await api(app.base, "/auth/email/code/start", { email });
  const code = lastCode(email)!;
  for (let i = 1; i <= 4; i++) {
    const r = await api(app.base, "/auth/email/code/verify", { email, code: wrong(code) });
    assert.equal(r.status, 400);
    assert.equal(r.data.attemptsLeft, 5 - i);
  }
  const fifth = await api(app.base, "/auth/email/code/verify", { email, code: wrong(code) });
  assert.equal(fifth.status, 429);
  const right = await api(app.base, "/auth/email/code/verify", { email, code });
  assert.equal(right.status, 429);
  assert.match(right.data.error, /new one/);
  await skipCooldown(email);
  await api(app.base, "/auth/email/code/start", { email });
  const fresh = await api(app.base, "/auth/email/code/verify", { email, code: lastCode(email) });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.data.status, "new");
});

test("codes expire after 10 minutes; malformed input rejected", async () => {
  const email = `exp_${uniq()}@example.com`;
  await api(app.base, "/auth/email/code/start", { email });
  await sql("UPDATE email_otp_codes SET expires_at = $2 WHERE email = $1", [email, Date.now() - 1]);
  const r = await api(app.base, "/auth/email/code/verify", { email, code: lastCode(email) });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /expired/);
  assert.equal((await api(app.base, "/auth/email/code/verify", { email, code: "12ab" })).status, 400);
  assert.equal((await api(app.base, "/auth/email/code/start", { email: "nope" })).status, 400);
});

test("resend cooldown 60s; resend replaces the old code", async () => {
  const email = `cool_${uniq()}@example.com`;
  assert.equal((await api(app.base, "/auth/email/code/start", { email })).status, 200);
  const old = lastCode(email)!;
  const again = await api(app.base, "/auth/email/code/start", { email });
  assert.equal(again.status, 429);
  assert.ok(again.data.resendIn > 0 && again.data.resendIn <= 60);
  await skipCooldown(email);
  assert.equal((await api(app.base, "/auth/email/code/start", { email })).status, 200);
  const neu = lastCode(email)!;
  if (neu !== old) assert.equal((await api(app.base, "/auth/email/code/verify", { email, code: old })).status, 400);
  assert.equal((await api(app.base, "/auth/email/code/verify", { email, code: neu })).status, 200);
});

test("rate limits: per email (5/h) and per IP", async () => {
  const email = `rl_${uniq()}@example.com`;
  for (let i = 0; i < 5; i++) {
    assert.equal((await api(app.base, "/auth/email/code/start", { email })).status, 200, `send ${i}`);
    await skipCooldown(email);
  }
  assert.equal((await api(app.base, "/auth/email/code/start", { email })).status, 429);
  resetRateLimits();
  const ip = { "X-Forwarded-For": "203.0.113.77" };
  let last = 0;
  for (let i = 0; i < 21; i++) last = (await api(app.base, "/auth/email/code/start", { email: `ip${i}_${uniq()}@example.com` }, { headers: ip })).status;
  assert.equal(last, 429);
});

test("Settings: phone user adds + verifies an email by code → same account; sign in by email code keeps all data", async () => {
  const me = await phoneLogin(app.wsUrl, phoneNo(), { firstName: "Donny", username: `donny_${uniq()}` });
  const token = me.res.access ?? me.res.token;
  const uid = me.res.user.id;
  me.client.close();
  const email = `donny_${uniq()}@example.com`;
  assert.equal((await api(app.base, "/auth/email/code/link/start", { email })).status, 401);
  assert.equal((await api(app.base, "/auth/email/code/link/start", { email }, { token })).status, 200);
  const code = lastCode(email)!;
  // a link code is NOT a sign-in code
  assert.equal((await api(app.base, "/auth/email/code/verify", { email, code })).status, 400);
  const bad = await api(app.base, "/auth/email/code/link/verify", { email, code: wrong(code) }, { token });
  assert.equal(bad.status, 400);
  const ok = await api(app.base, "/auth/email/code/link/verify", { email, code }, { token });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, "linked");
  assert.ok(ok.data.identities.some((i: { provider: string; label: string }) => i.provider === "email" && i.label === email));

  await api(app.base, "/auth/email/code/start", { email });
  const si = await api(app.base, "/auth/email/code/verify", { email, code: lastCode(email) });
  assert.equal(si.data.status, "existing");
  assert.equal(si.data.user.id, uid);

  // forgot-password still works for this email and shares the mailer
  const f = await api(app.base, "/auth/password/forgot", { email });
  assert.equal(f.status, 200);
  assert.ok([...outbox].reverse().find((m) => m.to === email)?.link?.includes("/reset-password?token="));
});

test("Settings: an email already on another account with data is refused", async () => {
  const email = `taken_${uniq()}@example.com`;
  await api(app.base, "/auth/email/code/start", { email });
  const v = await api(app.base, "/auth/email/code/verify", { email, code: lastCode(email) });
  const other = await registerTicket(app.wsUrl, v.data.ticket, { firstName: "Otto", username: `otto_${uniq()}` });
  other.client.close();
  // give the other account data: it follows someone → not disposable
  const friend = await phoneLogin(app.wsUrl, phoneNo(), { firstName: "Fay", username: `fay_${uniq()}` });
  friend.client.close();
  (await import("../../server/store")).store.setFollow(other.res.user.id, friend.res.user.id, true);
  const me = await phoneLogin(app.wsUrl, phoneNo(), { firstName: "Mo", username: `mo_${uniq()}` });
  me.client.close();
  const token = me.res.access ?? me.res.token;
  assert.equal((await api(app.base, "/auth/email/code/link/start", { email }, { token })).status, 200);
  const r = await api(app.base, "/auth/email/code/link/verify", { email, code: lastCode(email) }, { token });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /another Open Lounge account/);
});

test("Settings: an EMPTY fresh duplicate that only had this email is absorbed by the phone account", async () => {
  const email = `dup_${uniq()}@example.com`;
  await api(app.base, "/auth/email/code/start", { email });
  const v = await api(app.base, "/auth/email/code/verify", { email, code: lastCode(email) });
  const dup = await registerTicket(app.wsUrl, v.data.ticket, { firstName: "Dup", username: `dup_${uniq()}` });
  dup.client.close();
  const me = await phoneLogin(app.wsUrl, phoneNo(), { firstName: "Real", username: `real_${uniq()}` });
  me.client.close();
  const token = me.res.access ?? me.res.token;
  await api(app.base, "/auth/email/code/link/start", { email }, { token });
  const r = await api(app.base, "/auth/email/code/link/verify", { email, code: lastCode(email) }, { token });
  assert.equal(r.status, 200);
  await skipCooldown(email);
  await api(app.base, "/auth/email/code/start", { email });
  const si = await api(app.base, "/auth/email/code/verify", { email, code: lastCode(email) });
  assert.equal(si.data.user.id, me.res.user.id);
});
