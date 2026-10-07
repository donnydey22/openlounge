// Integration tests: real HTTP API + realtime over a local Postgres, mock Google/Apple.
// Run: npm run test:auth   (needs a local Postgres; see harness.ts)
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { setTestEnv, startApp, startMockProviders, wipeDb, sql, api, phoneLogin, registerTicket, wsClient, oauthRoundTrip, type App, type MockProviders } from "./harness";

const keys = setTestEnv({ providers: true })!;
let app: App;
let mock: MockProviders;
let outbox: { to: string; subject: string; link?: string }[];
let resetRateLimits: () => void;
let store: typeof import("../../server/store").store;

const uniq = () => randomBytes(4).toString("hex");
const phoneNo = () => `+1415${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
const lastLink = (to: string) => [...outbox].reverse().find((m) => m.to === to)?.link ?? null;
const tokenOf = (link: string | null) => (link ? new URL(link).searchParams.get("token") : null);

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
  store = (await import("../../server/store")).store;
  app = await startApp();
});

after(async () => {
  await app?.close();
  await mock?.close();
});

beforeEach(() => resetRateLimits());

// ---------------- regression: phone OTP + /auth/validate unchanged ----------------

test("phone OTP signup + login still work and issue v2 sessions; GET /auth/validate 200 / 401", async () => {
  const phone = phoneNo();
  const su = await phoneLogin(app.wsUrl, phone, { firstName: "Pat", username: `pat_${uniq()}` });
  assert.equal(su.created, true);
  for (const k of ["token", "refresh", "access", "accessExpiresAt", "refreshExpiresAt", "sessionId", "user", "following", "unreadDms"]) assert.ok(k in su.res, `signup has ${k}`);
  const v = await api(app.base, "/auth/validate", undefined, { token: su.res.access });
  assert.equal(v.status, 200);
  assert.equal(v.data.ok, true);
  assert.equal(v.data.user.id, su.res.user.id);
  assert.deepEqual(Object.keys(v.data).sort(), ["following", "ok", "session", "unreadDms", "user"]);
  assert.ok(v.data.user.phoneMasked.endsWith(phone.slice(-4)));
  // legacy-style: the refresh token is accepted as a credential too (unchanged)
  assert.equal((await api(app.base, "/auth/validate", undefined, { token: su.res.refresh })).status, 200);

  const bad = await api(app.base, "/auth/validate", undefined, { token: "ol1.s_nope.zzzz.badsig" });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.reason, "invalid");
  assert.match(bad.headers.get("www-authenticate") ?? "", /invalid_token/);
  assert.equal((await api(app.base, "/auth/validate")).status, 401);

  // login again with the same number → same account
  const li = await phoneLogin(app.wsUrl, phone);
  assert.equal(li.res.status, "existing");
  assert.equal(li.res.user.id, su.res.user.id);
  // refresh + logout unchanged
  const r = await api(app.base, "/auth/refresh", { refreshToken: li.res.refresh });
  assert.equal(r.status, 200);
  assert.ok(r.data.access && r.data.refresh && r.data.refresh !== li.res.refresh);
  assert.equal((await api(app.base, "/auth/logout", {}, { token: r.data.access })).status, 200);
  const after = await api(app.base, "/auth/validate", undefined, { token: r.data.access });
  assert.equal(after.status, 401);
  assert.equal(after.data.reason, "revoked");
  su.client.close();
  li.client.close();

  // the phone number is a first-class identity row in Postgres
  await store.flush();
  const rows = await sql("SELECT user_id, provider, provider_subject, verified FROM auth_identities WHERE provider = 'phone' AND provider_subject = $1", [phone]);
  assert.deepEqual(rows, [{ user_id: su.res.user.id, provider: "phone", provider_subject: phone, verified: true }]);
});

// ---------------- provider flags ----------------

test("GET /auth/providers reflects env; buttons gated per provider", async () => {
  const on = await api(app.base, "/auth/providers");
  assert.deepEqual(on.data.providers, { phone: true, email: true, google: true, apple: true });
  const saved = { ...process.env };
  try {
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.APPLE_KEY_ID;
    delete process.env.AUTH_EMAIL_DEV;
    const off = await api(app.base, "/auth/providers");
    assert.deepEqual(off.data.providers, { phone: true, email: false, google: false, apple: false });
    const g = await fetch(`${app.base}/auth/google/start`, { redirect: "manual" });
    assert.equal(g.status, 302);
    assert.equal(g.headers.get("location"), "/auth/complete?error=unavailable");
    assert.equal((await api(app.base, "/auth/email/login", { email: "a@b.co", password: "whatever1" })).status, 404);
    assert.equal((await api(app.base, "/auth/email/signup", { email: "a@b.co", password: "whatever1" })).status, 404);
    // SMTP configured (no AUTH_EMAIL_DEV) also turns email on
    process.env.SMTP_HOST = "smtp.example.test";
    process.env.SMTP_FROM = "Open Lounge <hi@example.test>";
    assert.equal((await api(app.base, "/auth/providers")).data.providers.email, true);
  } finally {
    for (const k of ["GOOGLE_CLIENT_SECRET", "APPLE_KEY_ID", "AUTH_EMAIL_DEV", "SMTP_HOST", "SMTP_FROM"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// ---------------- Google ----------------

test("Google: new user → onboarding ticket → same account on next sign-in", async () => {
  const sub = "g-" + uniq();
  const email = `new_${uniq()}@gmail.com`;
  const first = await oauthRoundTrip(app, mock, "google", { sub, email, email_verified: true, given_name: "Gina", family_name: "Lee" });
  assert.equal(first.stage, "exchange");
  if (first.stage !== "exchange") return;
  assert.match(first.location, /^\/auth\/complete\?code=/);
  assert.equal(first.exchange.data.status, "new");
  assert.equal(first.exchange.data.profile.firstName, "Gina");
  // PKCE + scope + nonce on the authorize request
  assert.equal(first.authz.searchParams.get("code_challenge_method"), "S256");
  assert.equal(first.authz.searchParams.get("scope"), "openid email profile");
  assert.ok(first.authz.searchParams.get("nonce"));
  assert.match(first.cookieHeader ?? "", /ol_oauth_google=.+; Path=\/auth\/google\/; Max-Age=600; HttpOnly; SameSite=Lax/);
  // the one-time code works once
  assert.equal((await api(app.base, "/auth/exchange", { code: first.oneTime })).status, 400);

  const reg = await registerTicket(app.wsUrl, first.exchange.data.ticket, { firstName: "Gina", username: `gina_${uniq()}` });
  assert.equal(reg.res.ok, true);
  const uid = reg.res.user.id;
  reg.client.close();

  const again = await oauthRoundTrip(app, mock, "google", { sub, email, email_verified: true });
  assert.equal(again.stage, "exchange");
  if (again.stage !== "exchange") return;
  assert.equal(again.exchange.data.status, "existing");
  assert.equal(again.exchange.data.user.id, uid);
  const v = await api(app.base, "/auth/validate", undefined, { token: again.exchange.data.access });
  assert.equal(v.status, 200);
  assert.equal(v.data.user.id, uid);
});

test("phone user links Google in Settings, then signs in with Google and sees the same profile + DMs", async () => {
  const phone = phoneNo();
  const uname = `phoney_${uniq()}`;
  const me = await phoneLogin(app.wsUrl, phone, { firstName: "Phoebe", username: uname });
  const friend = await phoneLogin(app.wsUrl, phoneNo(), { firstName: "Fred", username: `fred_${uniq()}` });
  const meId = me.res.user.id;
  const sent = await me.client.req("dm:send", { to: friend.res.user.id, text: "hello from my phone account" });
  assert.equal(sent.ok, true);
  await friend.client.req("dm:send", { to: meId, text: "hi Phoebe!" });
  await me.client.req("me:update", { bio: "phone-era bio" }).catch(() => null);

  // Settings → "Add Google"
  const start = await api(app.base, "/auth/link/start", { provider: "google" }, { token: me.res.access });
  assert.equal(start.status, 200);
  assert.match(start.data.url, /^\/auth\/google\/start\?intent=/);
  const sub = "g-link-" + uniq();
  const linked = await oauthRoundTrip(app, mock, "google", { sub, email: `phoebe_${uniq()}@gmail.com`, email_verified: true }, { query: start.data.url.split("?")[1] });
  assert.equal(linked.stage, "exchange");
  if (linked.stage !== "exchange") return;
  assert.deepEqual(linked.exchange.data, { ok: true, status: "linked", provider: "google" });
  const ids = await api(app.base, "/auth/identities", undefined, { token: me.res.access });
  assert.deepEqual(ids.data.identities.map((i: { provider: string }) => i.provider).sort(), ["google", "phone"]);

  // a fresh device signs in with Google → the phone account
  const g = await oauthRoundTrip(app, mock, "google", { sub, email_verified: false });
  assert.equal(g.stage, "exchange");
  if (g.stage !== "exchange") return;
  assert.equal(g.exchange.data.status, "existing");
  assert.equal(g.exchange.data.user.id, meId);
  assert.equal(g.exchange.data.user.username, uname);
  assert.equal(g.exchange.data.user.name, "Phoebe");
  assert.ok(g.exchange.data.user.phoneMasked.endsWith(phone.slice(-4)));
  const c = wsClient(app.wsUrl);
  await c.open;
  const resumed = await c.req("session:resume", { token: g.exchange.data.access });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.user.id, meId);
  const hist = await c.req("dm:history", { peerId: friend.res.user.id });
  const texts = (hist.messages ?? []).map((m: { text: string }) => m.text);
  assert.ok(texts.includes("hello from my phone account") && texts.includes("hi Phoebe!"), JSON.stringify(texts));
  // and phone login still lands on the same account
  const p = await phoneLogin(app.wsUrl, phone);
  assert.equal(p.res.user.id, meId);
  for (const x of [me.client, friend.client, c, p.client]) x.close();

  // the same Google account can't be linked to someone else
  const other = await phoneLogin(app.wsUrl, phoneNo(), { firstName: "Otto", username: `otto_${uniq()}` });
  const st2 = await api(app.base, "/auth/link/start", { provider: "google" }, { token: other.res.access });
  const taken = await oauthRoundTrip(app, mock, "google", { sub, email_verified: true, email: "x@gmail.com" }, { query: st2.data.url.split("?")[1] });
  assert.equal(taken.stage, "callback");
  if (taken.stage === "callback") assert.equal(taken.error, "taken");
  other.client.close();
});

test("linking rules: verified email links to the existing account; unverified never does", async () => {
  // an email+password account (verified by link)
  const email = `link_${uniq()}@example.com`;
  assert.equal((await api(app.base, "/auth/email/signup", { email, password: "correct horse" })).data.ok, true);
  const ver = await api(app.base, "/auth/email/verify", { token: tokenOf(lastLink(email)) });
  assert.equal(ver.data.status, "new");
  const reg = await registerTicket(app.wsUrl, ver.data.ticket, { firstName: "Ella", username: `ella_${uniq()}` });
  const uid = reg.res.user.id;
  reg.client.close();

  // Google says the same email but NOT verified → brand-new account flow, no link
  const unv = await oauthRoundTrip(app, mock, "google", { sub: "g-unv-" + uniq(), email: email.toUpperCase(), email_verified: false });
  assert.equal(unv.stage === "exchange" && unv.exchange.data.status, "new");
  // Apple says the same email, verified ("true" string, Apple-style) → linked into Ella's account
  const ap = await oauthRoundTrip(app, mock, "apple", { sub: "a-ver-" + uniq(), email, email_verified: "true" });
  assert.equal(ap.stage, "exchange");
  if (ap.stage !== "exchange") return;
  assert.equal(ap.exchange.data.status, "existing");
  assert.equal(ap.exchange.data.user.id, uid);
  // nothing else got linked by the unverified attempt
  const ids = store.identitiesOf(uid).map((i) => i.provider).sort();
  assert.deepEqual(ids, ["apple", "email"]);
});

test("OAuth callback security: state, cookie binding, nonce, audience, signature", async () => {
  const claims = { sub: "g-sec-" + uniq(), email: "sec@gmail.com", email_verified: true };
  const t1 = await oauthRoundTrip(app, mock, "google", claims, { tamperState: true });
  assert.equal(t1.stage === "callback" && t1.error, "expired");
  const t2 = await oauthRoundTrip(app, mock, "google", claims, { dropCookie: true });
  assert.equal(t2.stage === "callback" && t2.error, "expired");
  const t3 = await oauthRoundTrip(app, mock, "google", claims, { nonceOverride: "replayed-nonce" });
  assert.equal(t3.stage === "callback" && t3.error, "failed");
  const t4 = await oauthRoundTrip(app, mock, "google", claims, { audOverride: "someone-elses-client-id" });
  assert.equal(t4.stage === "callback" && t4.error, "failed");
  // provider error (user cancelled)
  const st = await fetch(`${app.base}/auth/google/start`, { redirect: "manual" });
  const cookie = (st.headers.get("set-cookie") ?? "").split(";")[0];
  const state = new URL(st.headers.get("location")!).searchParams.get("state")!;
  const cancel = await fetch(`${app.base}/auth/google/callback?error=access_denied&state=${state}`, { headers: { Cookie: cookie }, redirect: "manual" });
  assert.equal(cancel.headers.get("location"), "/auth/complete?error=cancelled");
  // garbage exchange codes
  assert.equal((await api(app.base, "/auth/exchange", { code: "x".repeat(43) })).status, 400);
});

test("native wrapper path: app=1 returns via openlounge:// deep link; code needs the app's verifier", async () => {
  const verifier = randomBytes(32).toString("base64url");
  const cc = createHash("sha256").update(verifier).digest("base64url");
  const sub = "g-app-" + uniq();
  const noVerifier = await oauthRoundTrip(app, mock, "google", { sub, email: `app_${uniq()}@gmail.com`, email_verified: true }, { query: `app=1&cc=${cc}` });
  assert.equal(noVerifier.stage, "exchange");
  if (noVerifier.stage !== "exchange") return;
  assert.match(noVerifier.location, /^openlounge:\/\/auth\?code=/);
  assert.equal(noVerifier.exchange.status, 400, "a code intercepted from the deep link is useless without the verifier");
  const ok = await oauthRoundTrip(app, mock, "google", { sub, email_verified: true }, { query: `app=1&cc=${cc}`, codeVerifier: verifier });
  assert.equal(ok.stage === "exchange" && ok.exchange.data.status, "new");
  // errors also go back to the app
  const st = await fetch(`${app.base}/auth/google/start?app=1`, { redirect: "manual" });
  const cookie = (st.headers.get("set-cookie") ?? "").split(";")[0];
  const state = new URL(st.headers.get("location")!).searchParams.get("state")!;
  const cancel = await fetch(`${app.base}/auth/google/callback?error=access_denied&state=${state}`, { headers: { Cookie: cookie }, redirect: "manual" });
  assert.equal(cancel.headers.get("location"), "openlounge://auth?error=cancelled");
});

test("start redirects to the canonical public host first (state cookie must live there)", async () => {
  const res = await new Promise<http.IncomingMessage>((resolve) =>
    http.get(`${app.base}/auth/google/start?app=1`, { headers: { Host: "openlounge-production.up.railway.app" } }, resolve),
  );
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, `${app.base}/auth/google/start?app=1`);
  res.resume();
});

// ---------------- Apple ----------------

test("Apple: form_post callback, first-time name, private relay email, ES256 client secret, returning user", async () => {
  const sub = "001234." + uniq();
  const relay = `${uniq()}@privaterelay.appleid.com`;
  const first = await oauthRoundTrip(app, mock, "apple", { sub, email: relay, email_verified: "true", is_private_email: "true" }, { appleUser: { name: { firstName: "Ada", lastName: "Byron" }, email: relay } });
  assert.equal(first.stage, "exchange");
  if (first.stage !== "exchange") return;
  assert.equal(first.status, 303, "POST callback answers 303 → GET /auth/complete");
  assert.equal(first.authz.searchParams.get("response_mode"), "form_post");
  assert.equal(first.authz.searchParams.get("scope"), "name email");
  assert.equal(first.exchange.data.status, "new");
  assert.equal(first.exchange.data.profile.firstName, "Ada");
  assert.equal(first.exchange.data.profile.lastName, "Byron");
  // the token request carried a valid ES256 client secret (the mock verified it against the key pair)
  const tr = mock.tokenRequests.at(-1)!;
  assert.equal(tr.client_id, process.env.APPLE_SERVICES_ID);
  assert.equal(JSON.parse(Buffer.from(tr.client_secret.split(".")[0], "base64url").toString()).alg, "ES256");
  const reg = await registerTicket(app.wsUrl, first.exchange.data.ticket, { firstName: "Ada", username: `ada_${uniq()}` });
  const uid = reg.res.user.id;
  reg.client.close();
  const ids = await api(app.base, "/auth/identities", undefined, { token: reg.res.access });
  assert.equal(ids.data.identities[0].provider, "apple");
  assert.equal(ids.data.identities[0].privateRelay, true);

  // later sign-ins: no `user` form field, maybe no email — still the same account
  const again = await oauthRoundTrip(app, mock, "apple", { sub });
  assert.equal(again.stage === "exchange" && again.exchange.data.user?.id, uid);
});

test("Apple state cookie is SameSite=None; Secure on https (form_post is a cross-site POST)", async () => {
  const saved = process.env.AUTH_PUBLIC_URL!;
  process.env.AUTH_PUBLIC_URL = saved.replace("http://", "https://");
  try {
    const res = await fetch(`${app.base}/auth/apple/start`, { redirect: "manual" });
    assert.match(res.headers.get("set-cookie") ?? "", /ol_oauth_apple=.+; Path=\/auth\/apple\/; Max-Age=600; HttpOnly; SameSite=None; Secure/);
    assert.match(new URL(res.headers.get("location")!).searchParams.get("redirect_uri")!, /^https:\/\/127\.0\.0\.1:\d+\/auth\/apple\/callback$/);
  } finally {
    process.env.AUTH_PUBLIC_URL = saved;
  }
});

// ---------------- email ----------------

test("email: signup → verify link → onboarding → login; wrong password and unknown email look the same", async () => {
  const email = `Mixed.Case_${uniq()}@Example.com`;
  const s = await api(app.base, "/auth/email/signup", { email, password: "s3cret-pass" });
  assert.deepEqual(s.data, { ok: true, sent: true });
  const link = lastLink(email.toLowerCase());
  assert.match(link ?? "", /\/verify-email\?token=/);
  assert.equal((await api(app.base, "/auth/email/signup", { email: "bad", password: "s3cret-pass" })).status, 400);
  assert.equal((await api(app.base, "/auth/email/signup", { email: `x${uniq()}@e.com`, password: "short" })).data.error, "Use at least 8 characters.");

  const v = await api(app.base, "/auth/email/verify", { token: tokenOf(link) });
  assert.equal(v.data.status, "new");
  assert.equal((await api(app.base, "/auth/email/verify", { token: tokenOf(link) })).status, 400, "verification link is single use");
  const reg = await registerTicket(app.wsUrl, v.data.ticket, { firstName: "Em", username: `em_${uniq()}` });
  assert.equal(reg.res.ok, true);
  reg.client.close();
  await store.flush();
  const [row] = await sql<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [reg.res.user.id]);
  assert.match(row.password_hash, /^scrypt\$32768\$8\$1\$/);
  const [ident] = await sql("SELECT provider, provider_subject, email, verified FROM auth_identities WHERE user_id = $1", [reg.res.user.id]);
  assert.deepEqual(ident, { provider: "email", provider_subject: email.toLowerCase(), email: email.toLowerCase(), verified: true });

  const ok = await api(app.base, "/auth/email/login", { email: email.toUpperCase(), password: "s3cret-pass" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.id, reg.res.user.id);
  assert.equal((await api(app.base, "/auth/validate", undefined, { token: ok.data.access })).status, 200);
  const wrong = await api(app.base, "/auth/email/login", { email, password: "nope-nope" });
  const unknown = await api(app.base, "/auth/email/login", { email: `ghost_${uniq()}@example.com`, password: "nope-nope" });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.data.error, unknown.data.error);

  // signing up again with a registered email: same response, a "you already have an account" mail instead
  const n = outbox.length;
  const dup = await api(app.base, "/auth/email/signup", { email, password: "another-pass" });
  assert.deepEqual(dup.data, { ok: true, sent: true });
  assert.equal(outbox.length, n + 1);
  assert.equal(outbox.at(-1)!.subject, "Your Open Lounge account");
});

test("email user adds a phone number in Settings; phone OTP then lands on the same account", async () => {
  const email = `addphone_${uniq()}@example.com`;
  await api(app.base, "/auth/email/signup", { email, password: "pass-word-1" });
  const v = await api(app.base, "/auth/email/verify", { token: tokenOf(lastLink(email)) });
  const reg = await registerTicket(app.wsUrl, v.data.ticket, { firstName: "Eve", username: `eve_${uniq()}` });
  const uid = reg.res.user.id;
  const phone = phoneNo();
  // reg.client is signed in (auth:register signs the socket in)
  assert.equal((await reg.client.req("auth:requestCode", { phone })).ok, true);
  const bad = await reg.client.req("account:linkPhone", { phone, code: "123456" });
  assert.equal(bad.ok, false);
  const linked = await reg.client.req("account:linkPhone", { phone, code: "000000" });
  assert.equal(linked.ok, true);
  assert.ok(linked.user.phoneMasked.endsWith(phone.slice(-4)));
  const p = await phoneLogin(app.wsUrl, phone);
  assert.equal(p.res.status, "existing");
  assert.equal(p.res.user.id, uid);
  assert.equal(p.res.user.username, reg.res.user.username);
  // a number that belongs to someone else can't be added
  const otherPhone = phoneNo();
  const other = await phoneLogin(app.wsUrl, otherPhone, { firstName: "Oz", username: `oz_${uniq()}` });
  const taken = await reg.client.req("account:linkPhone", { phone: otherPhone, code: "000000" });
  assert.equal(taken.ok, false);
  for (const x of [reg.client, p.client, other.client]) x.close();
});

test("phone user adds email+password in Settings; removing methods never removes the last one", async () => {
  const me = await phoneLogin(app.wsUrl, phoneNo(), { firstName: "Paul", username: `paul_${uniq()}` });
  const email = `paul_${uniq()}@example.com`;
  assert.equal((await api(app.base, "/auth/email/link", { email, password: "paul-pass-1" })).status, 401, "needs a session");
  const l = await api(app.base, "/auth/email/link", { email, password: "paul-pass-1" }, { token: me.res.access });
  assert.deepEqual(l.data, { ok: true, sent: true });
  const v = await api(app.base, "/auth/email/verify", { token: tokenOf(lastLink(email)) });
  assert.deepEqual(v.data, { ok: true, status: "linked", provider: "email" });
  const li = await api(app.base, "/auth/email/login", { email, password: "paul-pass-1" });
  assert.equal(li.data.user.id, me.res.user.id);

  const ids = (await api(app.base, "/auth/identities", undefined, { token: me.res.access })).data;
  assert.equal(ids.hasPassword, true);
  const phoneId = ids.identities.find((i: { provider: string }) => i.provider === "phone").id;
  const emailId = ids.identities.find((i: { provider: string }) => i.provider === "email").id;
  const rm = await api(app.base, "/auth/identities/remove", { id: phoneId }, { token: me.res.access });
  assert.equal(rm.status, 200);
  assert.equal(store.users.get(me.res.user.id)!.phone, undefined);
  const last = await api(app.base, "/auth/identities/remove", { id: emailId }, { token: me.res.access });
  assert.equal(last.status, 400);
  assert.match(last.data.error, /another way to sign in/);
  me.client.close();
});

// ---------------- password reset lifecycle ----------------

async function emailAccount(password = "first-pass-1") {
  const email = `reset_${uniq()}@example.com`;
  await api(app.base, "/auth/email/signup", { email, password });
  const v = await api(app.base, "/auth/email/verify", { token: tokenOf(lastLink(email)) });
  const reg = await registerTicket(app.wsUrl, v.data.ticket, { firstName: "Rae", username: `rae_${uniq()}` });
  reg.client.close();
  return { email, uid: reg.res.user.id as string, access: reg.res.access as string };
}

test("reset token lifecycle: generic forgot, single use, weak password keeps token, revokes every session, supersedes others", async () => {
  const { email, uid, access } = await emailAccount();
  const second = await api(app.base, "/auth/email/login", { email, password: "first-pass-1" });
  const n = outbox.length;
  const unknown = await api(app.base, "/auth/password/forgot", { email: `nobody_${uniq()}@example.com` });
  assert.deepEqual(unknown.data, { ok: true, sent: true });
  assert.equal(outbox.length, n, "no mail for unknown addresses");
  const known = await api(app.base, "/auth/password/forgot", { email });
  assert.deepEqual(known.data, unknown.data, "identical response (no account enumeration)");
  const t1 = tokenOf(lastLink(email))!;
  await api(app.base, "/auth/password/forgot", { email });
  const t2 = tokenOf(lastLink(email))!;
  assert.notEqual(t1, t2);
  await store.flush();
  const rows = await sql<{ token_hash: string; expires_at: string; created_at: string }>("SELECT token_hash, expires_at, created_at FROM password_reset_tokens WHERE user_id = $1", [uid]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => !Object.values(r).includes(t1) && !Object.values(r).includes(t2)), "only hashes are stored");
  assert.ok(rows.every((r) => Number(r.expires_at) - Number(r.created_at) === 30 * 60_000), "30 minute expiry");

  const weak = await api(app.base, "/auth/password/reset", { token: t1, password: "short" });
  assert.equal(weak.status, 400);
  const ok = await api(app.base, "/auth/password/reset", { token: t1, password: "brand-new-pass" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await api(app.base, "/auth/password/reset", { token: t1, password: "brand-new-pass2" })).status, 400, "single use");
  assert.equal((await api(app.base, "/auth/password/reset", { token: t2, password: "brand-new-pass2" })).status, 400, "other outstanding links are superseded");
  // every existing session is revoked
  for (const tok of [access, second.data.access]) {
    const v = await api(app.base, "/auth/validate", undefined, { token: tok });
    assert.equal(v.status, 401);
    assert.equal(v.data.reason, "revoked");
  }
  assert.equal((await api(app.base, "/auth/email/login", { email, password: "first-pass-1" })).status, 401);
  assert.equal((await api(app.base, "/auth/email/login", { email, password: "brand-new-pass" })).status, 200);
});

test("reset token expiry", async () => {
  const { email, uid } = await emailAccount();
  await api(app.base, "/auth/password/forgot", { email });
  const t = tokenOf(lastLink(email))!;
  await sql("UPDATE password_reset_tokens SET expires_at = $2 WHERE user_id = $1", [uid, Date.now() - 1]);
  assert.equal((await api(app.base, "/auth/password/reset", { token: t, password: "whatever-123" })).status, 400);
});

test("forgot password for a Google-only account (verified email) lets them set a password → email identity", async () => {
  const email = `gonly_${uniq()}@gmail.com`;
  const g = await oauthRoundTrip(app, mock, "google", { sub: "g-only-" + uniq(), email, email_verified: true });
  assert.equal(g.stage, "exchange");
  if (g.stage !== "exchange") return;
  const reg = await registerTicket(app.wsUrl, g.exchange.data.ticket, { firstName: "Gus", username: `gus_${uniq()}` });
  reg.client.close();
  await api(app.base, "/auth/password/forgot", { email });
  const mail = outbox.at(-1)!;
  assert.equal(mail.subject, "Set your Open Lounge password");
  assert.equal((await api(app.base, "/auth/password/reset", { token: tokenOf(mail.link!), password: "gus-password" })).status, 200);
  const li = await api(app.base, "/auth/email/login", { email, password: "gus-password" });
  assert.equal(li.data.user.id, reg.res.user.id);
});

// ---------------- rate limits ----------------

test("rate limits: login per email and per IP", async () => {
  const email = `rl_${uniq()}@example.com`;
  const codes: number[] = [];
  for (let i = 0; i < 9; i++) codes.push((await api(app.base, "/auth/email/login", { email, password: "wrong-pass" }, { headers: { "X-Forwarded-For": `10.0.0.${i}` } })).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 401, 401, 401, 429]);
  resetRateLimits();
  const ipCodes: number[] = [];
  for (let i = 0; i < 21; i++) ipCodes.push((await api(app.base, "/auth/email/login", { email: `ip${i}_${uniq()}@example.com`, password: "wrong-pass" }, { headers: { "X-Forwarded-For": "10.9.9.9" } })).status);
  assert.equal(ipCodes.filter((c) => c === 401).length, 20);
  assert.equal(ipCodes.at(-1), 429);
  const r429 = await api(app.base, "/auth/email/login", { email, password: "x-wrong-x" }, { headers: { "X-Forwarded-For": "10.9.9.9" } });
  assert.match(r429.data.error, /Too many attempts/);
});

test("rate limits: forgot (per email silent, per IP 429) and reset per IP", async () => {
  const { email } = await emailAccount();
  const n = outbox.length;
  const bodies = [];
  for (let i = 0; i < 5; i++) bodies.push((await api(app.base, "/auth/password/forgot", { email }, { headers: { "X-Forwarded-For": `10.1.0.${i}` } })).data);
  assert.ok(bodies.every((b) => b.ok === true), "still generic success");
  assert.equal(outbox.length - n, 3, "only 3 reset mails per hour per address");
  resetRateLimits();
  const ip: number[] = [];
  for (let i = 0; i < 11; i++) ip.push((await api(app.base, "/auth/password/forgot", { email: `f${i}_${uniq()}@example.com` }, { headers: { "X-Forwarded-For": "10.2.2.2" } })).status);
  assert.equal(ip.at(-1), 429);
  assert.equal(ip.filter((c) => c === 200).length, 10);
  const rs: number[] = [];
  for (let i = 0; i < 11; i++) rs.push((await api(app.base, "/auth/password/reset", { token: randomBytes(32).toString("base64url"), password: "long-enough-1" }, { headers: { "X-Forwarded-For": "10.3.3.3" } })).status);
  assert.equal(rs.filter((c) => c === 400).length, 10);
  assert.equal(rs.at(-1), 429);
});

test("CORS: unchanged allowlist for JSON routes; Apple form_post route isn't CORS-gated", async () => {
  const evil = await api(app.base, "/auth/email/login", { email: "a@b.co", password: "whatever1" }, { headers: { Origin: "https://evil.example" } });
  assert.equal(evil.status, 403);
  const pre = await fetch(`${app.base}/auth/exchange`, { method: "OPTIONS", headers: { Origin: "https://openlounge.app" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "https://openlounge.app");
  const ap = await fetch(`${app.base}/auth/apple/callback`, { method: "POST", headers: { Origin: "https://appleid.apple.com", "Content-Type": "application/x-www-form-urlencoded" }, body: "state=x&code=y", redirect: "manual" });
  assert.equal(ap.status, 303);
  assert.equal(ap.headers.get("location"), "/auth/complete?error=expired");
});
