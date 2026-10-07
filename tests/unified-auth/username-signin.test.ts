// @username sign-in: account password (set in Settings) or a 6-digit code to the account's verified email.
// Real HTTP API over local Postgres + in-memory outbox. Run: npm run test:auth
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTestEnv, startApp, startMockProviders, wipeDb, sql, api, phoneLogin, oauthRoundTrip, registerTicket, type App, type MockProviders } from "./harness";

const keys = setTestEnv({ providers: true })!;
let app: App;
let mock: MockProviders;
let outbox: { to: string; subject: string; text: string; code?: string }[];
let resetRateLimits: () => void;

const uniq = () => randomBytes(4).toString("hex");
const phoneNo = () => `+1415${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
const lastCode = (to: string) => [...outbox].reverse().find((m) => m.to === to && m.code)?.code ?? null;
const wrong = (c: string) => String((Number(c) + 1) % 1_000_000).padStart(6, "0");
const BAD = "Username or password is incorrect";

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

/** phone account @handle with a password set from Settings */
async function phoneUserWithPassword(password = "correct horse battery") {
  const handle = `dd_${uniq()}`;
  const { client, res } = await phoneLogin(app.wsUrl, phoneNo(), { firstName: "Donny", username: handle });
  client.close();
  const set = await api(app.base, "/auth/password/set", { password }, { token: res.access ?? res.token });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  return { handle, userId: res.user.id as string, token: (res.access ?? res.token) as string, password };
}

test("unit: password hashing is salted scrypt, verify is exact, malformed hashes are false", async () => {
  const { hashPassword, verifyPassword, passwordProblem } = await import("../../server/authx/password");
  const a = await hashPassword("hunter2hunter2");
  const b = await hashPassword("hunter2hunter2");
  assert.match(a, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(a, b, "random salt");
  assert.equal(await verifyPassword("hunter2hunter2", a), true);
  assert.equal(await verifyPassword("hunter2hunter3", a), false);
  assert.equal(await verifyPassword("hunter2hunter2", "garbage"), false);
  assert.ok(passwordProblem("short7!"));
  assert.equal(passwordProblem("eightchr"), null);
});

test("unit: masking + lockout counters", async () => {
  const { maskEmail, maskPhone } = await import("../../server/authx/routes");
  assert.equal(maskEmail("donny@gmail.com"), "d***@gmail.com");
  assert.equal(maskPhone("+14155550123"), "•••• 0123");
  const rl = await import("../../server/authx/ratelimit");
  for (let i = 0; i < 4; i++) rl.recordFailure("u", "1.1.1.1");
  assert.equal(rl.isLockedOut("u", "1.1.1.1"), false);
  rl.recordFailure("u", "1.1.1.1");
  assert.equal(rl.isLockedOut("u", "1.1.1.1"), true);
  assert.equal(rl.isLockedOut("u", "2.2.2.2"), false, "pair lock is per IP");
  for (let i = 0; i < 15; i++) rl.recordFailure("u", `9.9.9.${i}`);
  assert.equal(rl.isLockedOut("u", "3.3.3.3"), true, "account-wide lock after 20 failures from anywhere");
});

test("Settings: set password (min 8), change needs current; stored hashed", async () => {
  const handle = `pw_${uniq()}`;
  const { client, res } = await phoneLogin(app.wsUrl, phoneNo(), { firstName: "Pat", username: handle });
  client.close();
  const token = res.access ?? res.token;
  assert.equal((await api(app.base, "/auth/password/set", { password: "short" }, { token })).status, 400);
  assert.equal((await api(app.base, "/auth/password/set", { password: "longenough1" })).status, 401, "needs a session");
  assert.equal((await api(app.base, "/auth/password/set", { password: "longenough1" }, { token })).status, 200);
  const ids = await api(app.base, "/auth/identities", undefined, { token });
  assert.equal(ids.data.hasPassword, true);
  assert.equal(ids.data.username, handle);
  await (await import("../../server/store")).store.flush();
  const [row] = await sql<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [res.user.id]);
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes("longenough1"));
  assert.equal((await api(app.base, "/auth/password/set", { password: "another-one" }, { token })).status, 401, "change without current");
  assert.equal((await api(app.base, "/auth/password/set", { password: "another-one", currentPassword: "longenough1" }, { token })).status, 200);
  assert.equal((await api(app.base, "/auth/username/login", { username: handle, password: "another-one" })).status, 200);
});

test("@username / USERNAME / username all sign into the SAME unified account; same session flow", async () => {
  const u = await phoneUserWithPassword();
  for (const name of [`@${u.handle}`, u.handle.toUpperCase(), `  ${u.handle} `, `@${u.handle.toUpperCase()}`]) {
    const r = await api(app.base, "/auth/username/login", { username: name, password: u.password });
    assert.equal(r.status, 200, name);
    assert.equal(r.data.status, "existing");
    assert.equal(r.data.user.id, u.userId);
    assert.ok(r.data.access && r.data.refresh, "access + refresh like every other method");
    const v = await api(app.base, "/auth/validate", undefined, { token: r.data.access });
    assert.equal(v.status, 200);
    assert.equal(v.data.user.id, u.userId);
  }
  const r = await api(app.base, "/auth/username/login", { username: u.handle, password: u.password });
  const ref = await api(app.base, "/auth/refresh", { refreshToken: r.data.refresh });
  assert.equal(ref.status, 200, JSON.stringify(ref.data));
});

test("wrong password and unknown username give the identical generic error", async () => {
  const u = await phoneUserWithPassword();
  const a = await api(app.base, "/auth/username/login", { username: u.handle, password: "nope-nope-nope" });
  const b = await api(app.base, "/auth/username/login", { username: `ghost_${uniq()}`, password: "nope-nope-nope" });
  const handle = `nopw_${uniq()}`;
  (await phoneLogin(app.wsUrl, phoneNo(), { firstName: "N", username: handle })).client.close();
  const c = await api(app.base, "/auth/username/login", { username: handle, password: "nope-nope-nope" });
  for (const r of [a, b, c]) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.data, { ok: false, error: BAD });
  }
});

test("lockout: 5 wrong passwords per username+IP → locked, even the right password; other IP unaffected", async () => {
  const u = await phoneUserWithPassword();
  for (let i = 0; i < 5; i++) assert.equal((await api(app.base, "/auth/username/login", { username: u.handle, password: `wrong-${i}-xxxx` })).status, 401);
  const locked = await api(app.base, "/auth/username/login", { username: u.handle, password: u.password });
  assert.equal(locked.status, 429);
  // unknown usernames lock the same way (no existence oracle)
  const ghost = `ghost_${uniq()}`;
  for (let i = 0; i < 5; i++) await api(app.base, "/auth/username/login", { username: ghost, password: "whatever-xx" });
  assert.equal((await api(app.base, "/auth/username/login", { username: ghost, password: "whatever-xx" })).status, 429);
  const other = await api(app.base, "/auth/username/login", { username: u.handle, password: u.password }, { headers: { "X-Forwarded-For": "203.0.113.9" } });
  assert.equal(other.status, 200, "a different client IP isn't locked by someone else's guesses");
});

test("code instead: Google-verified email gets the code (masked), code → same account; single use; 5 attempts", async () => {
  const email = `donny_${uniq()}@gmail.com`;
  const first = await oauthRoundTrip(app, mock, "google", { sub: "g-" + uniq(), email, email_verified: true, given_name: "Donny" });
  if (first.stage !== "exchange") return assert.fail("exchange");
  const handle = `donnydey_${uniq()}`.slice(0, 20);
  const reg = await registerTicket(app.wsUrl, first.exchange.data.ticket, { firstName: "Donny", username: handle });
  const uid = reg.res.user.id;
  reg.client.close();

  const s = await api(app.base, "/auth/username/code/start", { username: `@${handle.toUpperCase()}` });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.sent, true);
  assert.equal(s.data.email, `d***@gmail.com`);
  assert.ok(!JSON.stringify(s.data).includes(email), "full address never returned");
  const code = lastCode(email)!;
  assert.match(code, /^\d{6}$/);
  // stored hashed
  const rows = await sql<{ code_hash: string; purpose: string }>("SELECT code_hash, purpose FROM email_otp_codes WHERE email = $1", [email]);
  assert.equal(rows[0].purpose, "username");
  assert.ok(!rows[0].code_hash.includes(code));
  // resend cooldown
  assert.equal((await api(app.base, "/auth/username/code/start", { username: handle })).status, 429);

  const bad = await api(app.base, "/auth/username/code/verify", { username: handle, code: wrong(code) });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.attemptsLeft, 4);
  const ok = await api(app.base, "/auth/username/code/verify", { username: handle, code });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.id, uid);
  assert.ok(ok.data.refresh);
  assert.equal((await api(app.base, "/auth/username/code/verify", { username: handle, code })).status, 400, "single use");

  // 5 wrong → dead even if right
  await sql("UPDATE email_otp_codes SET created_at = created_at - 61000 WHERE email = $1", [email]);
  await api(app.base, "/auth/username/code/start", { username: handle });
  const c2 = lastCode(email)!;
  for (let i = 0; i < 5; i++) await api(app.base, "/auth/username/code/verify", { username: handle, code: wrong(c2) });
  assert.equal((await api(app.base, "/auth/username/code/verify", { username: handle, code: c2 })).status, 429);
});

test("code instead: unknown username → same 200 shape, nothing sent; phone-only shows masked phone; lookups rate limited", async () => {
  const before = outbox.length;
  const g = await api(app.base, "/auth/username/code/start", { username: `ghost_${uniq()}` });
  assert.equal(g.status, 200);
  assert.deepEqual(g.data, { ok: true, sent: false, email: null, phone: null });
  const phone = phoneNo();
  const handle = `ph_${uniq()}`;
  (await phoneLogin(app.wsUrl, phone, { firstName: "P", username: handle })).client.close();
  const p = await api(app.base, "/auth/username/code/start", { username: handle });
  assert.equal(p.data.sent, false);
  assert.equal(p.data.phone, `•••• ${phone.slice(-4)}`);
  assert.equal(outbox.length, before);
  const bad = await api(app.base, "/auth/username/code/verify", { username: `ghost_${uniq()}`, code: "123456" });
  assert.equal(bad.status, 400);
  let limited = false;
  for (let i = 0; i < 20 && !limited; i++) limited = (await api(app.base, "/auth/username/code/start", { username: `ghost_${uniq()}` })).status === 429;
  assert.ok(limited, "per-IP lookup budget");
});

test("unified: email+password, @username+password and phone are one account; password survives email removal", async () => {
  const u = await phoneUserWithPassword("shared-password-1");
  const email = `uni_${uniq()}@example.com`;
  await api(app.base, "/auth/email/code/link/start", { email }, { token: u.token });
  const l = await api(app.base, "/auth/email/code/link/verify", { email, code: lastCode(email) }, { token: u.token });
  assert.equal(l.status, 200, JSON.stringify(l.data));
  const viaEmail = await api(app.base, "/auth/email/login", { email, password: "shared-password-1" });
  assert.equal(viaEmail.data.user.id, u.userId);
  const viaCode = await api(app.base, "/auth/username/code/start", { username: u.handle });
  assert.equal(viaCode.data.email, `u***@example.com`, "verified email identity is the code destination");
  const id = l.data.identities.find((i: { provider: string }) => i.provider === "email").id;
  assert.equal((await api(app.base, "/auth/identities/remove", { id }, { token: u.token })).status, 200);
  const viaName = await api(app.base, "/auth/username/login", { username: `@${u.handle}`, password: "shared-password-1" });
  assert.equal(viaName.status, 200);
  assert.equal(viaName.data.user.id, u.userId);
  // remove password → username+password stops working (generic error)
  assert.equal((await api(app.base, "/auth/password/remove", { currentPassword: "shared-password-1" }, { token: u.token })).status, 200);
  const gone = await api(app.base, "/auth/username/login", { username: u.handle, password: "shared-password-1" });
  assert.deepEqual(gone.data, { ok: false, error: BAD });
});
