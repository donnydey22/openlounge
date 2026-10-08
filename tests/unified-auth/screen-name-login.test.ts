// Unified sign-in: ONE field (email OR screen name) + password, and forgot-password by screen name.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTestEnv, startApp, wipeDb, api, phoneLogin, registerTicket, type App } from "./harness";

setTestEnv({ providers: true });
let app: App;
let outbox: { to: string; subject: string; link?: string }[];
let resetRateLimits: () => void;
const uniq = () => randomBytes(4).toString("hex");
const tokenOf = (link?: string | null) => (link ? new URL(link).searchParams.get("token") : null);
const lastLink = (to: string) => [...outbox].reverse().find((m) => m.to === to)?.link ?? null;

before(async () => {
  await wipeDb();
  outbox = (await import("../../server/authx/mailer")).outbox;
  resetRateLimits = (await import("../../server/authx/ratelimit")).resetRateLimits;
  app = await startApp();
});
after(async () => app?.close());
beforeEach(() => resetRateLimits());

async function account(password = "s3cret-pass") {
  const email = `sn_${uniq()}@example.com`;
  const username = `sn_${uniq()}`;
  await api(app.base, "/auth/email/signup", { email, password });
  const v = await api(app.base, "/auth/email/verify", { token: tokenOf(lastLink(email)) });
  const reg = await registerTicket(app.wsUrl, v.data.ticket, { firstName: "Sam", username });
  reg.client.close();
  return { email, username, uid: reg.res.user.id as string };
}

test("identifier = screen name, @screen name, mixed case, or email all sign in", async () => {
  const a = await account();
  for (const identifier of [a.username, `@${a.username}`, a.username.toUpperCase(), ` ${a.email.toUpperCase()} `]) {
    const r = await api(app.base, "/auth/email/login", { identifier, password: "s3cret-pass" });
    assert.equal(r.status, 200, identifier);
    assert.equal(r.data.user.id, a.uid);
  }
  // legacy body still works
  assert.equal((await api(app.base, "/auth/email/login", { email: a.email, password: "s3cret-pass" })).status, 200);
});

test("wrong password / unknown name / account without a password: same 401, no enumeration", async () => {
  const a = await account();
  const wrong = await api(app.base, "/auth/email/login", { identifier: a.username, password: "nope-nope" });
  const ghost = await api(app.base, "/auth/email/login", { identifier: `ghost_${uniq()}`, password: "nope-nope" });
  const phoneOnly = await phoneLogin(app.wsUrl, `+1415${Math.floor(1_000_000 + Math.random() * 8_999_999)}`, { firstName: "Pia", username: `pia_${uniq()}` });
  const nopw = await api(app.base, "/auth/email/login", { identifier: phoneOnly.res.user.username, password: "nope-nope" });
  phoneOnly.client.close();
  for (const r of [wrong, ghost, nopw]) assert.equal(r.status, 401);
  assert.equal(wrong.data.error, ghost.data.error);
  assert.equal(ghost.data.error, nopw.data.error);
  assert.equal((await api(app.base, "/auth/email/login", { identifier: "", password: "x" })).status, 400);
});

test("screen-name login is rate limited per name", async () => {
  const a = await account();
  let last = 0;
  for (let i = 0; i < 10; i++) last = (await api(app.base, "/auth/email/login", { identifier: a.username, password: "bad-bad-bad" })).status;
  assert.equal(last, 429);
});

test("forgot password by screen name mails the account's address; unknown name gets the same answer", async () => {
  const a = await account();
  const n = outbox.length;
  const known = await api(app.base, "/auth/password/forgot", { identifier: `@${a.username}` });
  assert.deepEqual(known.data, { ok: true, sent: true });
  assert.equal(outbox.length, n + 1);
  assert.equal(outbox.at(-1)!.to, a.email);
  const unknown = await api(app.base, "/auth/password/forgot", { identifier: `nobody_${uniq()}` });
  assert.deepEqual(unknown.data, known.data);
  assert.equal(outbox.length, n + 1);
  // the emailed link resets the password; the new one works with the screen name
  const reset = await api(app.base, "/auth/password/reset", { token: tokenOf(lastLink(a.email)), password: "brand-new-pass" });
  assert.equal(reset.status, 200);
  assert.equal((await api(app.base, "/auth/email/login", { identifier: a.username, password: "brand-new-pass" })).status, 200);
  assert.equal((await api(app.base, "/auth/password/reset", { token: tokenOf(lastLink(a.email)), password: "again-new-pass" })).status, 400, "single use");
});
