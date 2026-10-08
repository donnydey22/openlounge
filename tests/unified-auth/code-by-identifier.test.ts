// Sign-in code by ONE identifier: email or screen name → code to the address on file, only ever shown masked;
// a screen name without an address says which other way works (masked phone), never the address itself.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTestEnv, startApp, wipeDb, api, phoneLogin, registerTicket, type App } from "./harness";

setTestEnv({ providers: true });
let app: App;
let outbox: { to: string; subject: string; link?: string; code?: string }[];
let resetRateLimits: () => void;
const uniq = () => randomBytes(4).toString("hex");
const tokenOf = (link?: string | null) => (link ? new URL(link).searchParams.get("token") : null);
const lastMail = (to: string) => [...outbox].reverse().find((m) => m.to === to);

before(async () => {
  await wipeDb();
  outbox = (await import("../../server/authx/mailer")).outbox;
  resetRateLimits = (await import("../../server/authx/ratelimit")).resetRateLimits;
  app = await startApp();
});
after(async () => app?.close());
beforeEach(() => resetRateLimits());

async function account() {
  const email = `ci_${uniq()}@example.com`;
  const username = `ci_${uniq()}`;
  await api(app.base, "/auth/email/signup", { email, password: "s3cret-pass" });
  const v = await api(app.base, "/auth/email/verify", { token: tokenOf(lastMail(email)?.link) });
  const reg = await registerTicket(app.wsUrl, v.data.ticket, { firstName: "Cy", username });
  reg.client.close();
  return { email, username, uid: reg.res.user.id as string };
}

test("screen name → code to the masked address on file → signs into that account (address never returned)", async () => {
  const a = await account();
  const s = await api(app.base, "/auth/email/code/start", { identifier: `@${a.username.toUpperCase()}` });
  assert.equal(s.status, 200);
  assert.equal(s.data.sent, true);
  assert.equal(s.data.channel, "email");
  assert.equal(s.data.masked, `${a.email[0]}•••@example.com`);
  assert.equal(s.data.email, undefined, "address never revealed for a screen name");
  assert.ok(!JSON.stringify(s.data).includes(a.email));
  const code = lastMail(a.email)!.code!;
  assert.match(code, /^\d{6}$/);
  const bad = await api(app.base, "/auth/email/code/verify", { identifier: a.username, code: code === "000000" ? "111111" : "000000" });
  assert.equal(bad.status, 400);
  const v = await api(app.base, "/auth/email/code/verify", { identifier: a.username, code });
  assert.equal(v.status, 200);
  assert.equal(v.data.status, "existing");
  assert.equal(v.data.user.id, a.uid);
});

test("email identifier works the same as { email }", async () => {
  const a = await account();
  const s = await api(app.base, "/auth/email/code/start", { identifier: ` ${a.email.toUpperCase()} ` });
  assert.equal(s.data.sent, true);
  assert.equal(s.data.email, a.email);
  const v = await api(app.base, "/auth/email/code/verify", { identifier: a.email, code: lastMail(a.email)!.code });
  assert.equal(v.data.user.id, a.uid);
});

test("phone-only screen name → no mail, offers the masked phone; unknown name → no channel", async () => {
  const phone = `+1415${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
  const p = await phoneLogin(app.wsUrl, phone, { firstName: "Pia", username: `pia_${uniq()}` });
  p.client.close();
  const n = outbox.length;
  const r = await api(app.base, "/auth/email/code/start", { identifier: p.res.user.username });
  assert.deepEqual(r.data, { ok: true, sent: false, channel: "phone", masked: `•••${phone.slice(-4)}` });
  const u = await api(app.base, "/auth/email/code/start", { identifier: `nobody_${uniq()}` });
  assert.deepEqual(u.data, { ok: true, sent: false, channel: null, masked: null });
  assert.equal(outbox.length, n);
});
