// "Already have an Open Lounge account?": Google/Apple/email sign-in that would create a NEW account can instead be
// linked to an existing phone account — only after a real (Firebase) phone verification. Plus the safe clean-up of an
// empty duplicate account, and refusal when the duplicate has data.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTestEnv, startApp, startMockProviders, wipeDb, sql, api, phoneLogin, registerTicket, oauthRoundTrip, type App, type MockProviders } from "./harness";

const keys = setTestEnv({ providers: true })!;
let app: App;
let mock: MockProviders;
let resetRateLimits: () => void;
let store: typeof import("../../server/store").store;
let fb: typeof import("../../server/firebase");

const uniq = () => randomBytes(4).toString("hex");
const phoneNo = () => `+1415${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
/** fake Firebase: token "fb:<E.164>" proves that number; anything else fails */
const fbToken = (phone: string) => `fb:${phone}`;

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
    google: { authUrl: `${mock.url}/google/auth`, tokenUrl: `${mock.url}/google/token`, jwksUrl: `${mock.url}/google/jwks`, issuers: ["https://accounts.google.com"] },
    apple: { authUrl: `${mock.url}/apple/auth`, tokenUrl: `${mock.url}/apple/token`, jwksUrl: `${mock.url}/apple/jwks`, issuers: ["https://appleid.apple.com"] },
  });
  resetRateLimits = (await import("../../server/authx/ratelimit")).resetRateLimits;
  store = (await import("../../server/store")).store;
  fb = await import("../../server/firebase");
  fb.setPhoneVerifier(async (tok) => (tok.startsWith("fb:+") ? { ok: true, phone: tok.slice(3), uid: "fb-" + tok.slice(4) } : { ok: false, error: "That code didn't work." }));
  app = await startApp();
});

after(async () => {
  fb?.setPhoneVerifier(null);
  await Promise.race([Promise.all([app?.close(), mock?.close()]), new Promise((r) => setTimeout(r, 3000))]);
});

beforeEach(() => resetRateLimits());

async function phoneMember(name: string) {
  const phone = phoneNo();
  const m = await phoneLogin(app.wsUrl, phone, { firstName: name, username: `${name.toLowerCase()}_${uniq()}` });
  return { phone, id: m.res.user.id as string, access: m.res.access as string, client: m.client };
}

async function googleNew(sub: string, extra: Record<string, unknown> = {}) {
  const r = await oauthRoundTrip(app, mock, "google", { sub, email: `${sub}@gmail.com`, email_verified: true, given_name: "Donny", ...extra });
  assert.equal(r.stage, "exchange");
  if (r.stage !== "exchange") throw new Error("no exchange");
  return r.exchange.data;
}

test("new Google sign-in offers link-or-create; phone verification links it to the phone account; next Google sign-in goes straight there", async () => {
  const donny = await phoneMember("Donny");
  const sub = "g-" + uniq();
  const first = await googleNew(sub);
  assert.equal(first.status, "new");
  assert.ok(first.ticket, "create-new path still offered");
  assert.ok(typeof first.linkCode === "string" && first.linkCode.length >= 40, "link code offered");
  // nothing linked yet
  assert.equal(store.findIdentity("google", sub), null);

  const linked = await api(app.base, "/auth/link/phone", { linkCode: first.linkCode, idToken: fbToken(donny.phone) });
  assert.equal(linked.status, 200, JSON.stringify(linked.data));
  assert.equal(linked.data.status, "existing");
  assert.equal(linked.data.user.id, donny.id);
  assert.equal(linked.data.linked, "google");
  assert.equal(store.findIdentity("google", sub)?.userId, donny.id);
  const rows = await sql<{ user_id: string }>("SELECT user_id FROM auth_identities WHERE provider='google' AND provider_subject=$1", [sub]);
  assert.deepEqual(rows.map((r) => r.user_id), [donny.id]);

  // the code is single use and the "create new account" ticket is gone
  assert.equal((await api(app.base, "/auth/link/phone", { linkCode: first.linkCode, idToken: fbToken(donny.phone) })).status, 400);
  const reg = await registerTicket(app.wsUrl, first.ticket, { firstName: "Dup", username: `dup_${uniq()}` });
  assert.equal(reg.res.ok, false);
  reg.client.close();

  const again = await googleNew(sub);
  assert.equal(again.status, "existing");
  assert.equal(again.user.id, donny.id);
  donny.client.close();
});

test("Apple works the same; 'Create a new account' still works when chosen", async () => {
  const sub = "001." + uniq();
  const r = await oauthRoundTrip(app, mock, "apple", { sub, email: `${uniq()}@privaterelay.appleid.com`, email_verified: "true" });
  assert.equal(r.stage, "exchange");
  if (r.stage !== "exchange") return;
  assert.equal(r.exchange.data.status, "new");
  assert.ok(r.exchange.data.linkCode);
  const reg = await registerTicket(app.wsUrl, r.exchange.data.ticket, { firstName: "Ann", username: `ann_${uniq()}` });
  assert.equal(reg.res.ok, true);
  assert.equal(store.findIdentity("apple", sub)?.userId, reg.res.user.id);
  reg.client.close();
});

test("no linking without phone verification", async () => {
  const victim = await phoneMember("Victor");
  const sub = "g-" + uniq();
  // same name as the phone member: names never link anything
  const first = await googleNew(sub, { given_name: "Victor" });
  assert.equal(first.status, "new");

  // bad / missing Firebase token → refused, code NOT spent
  const bad = await api(app.base, "/auth/link/phone", { linkCode: first.linkCode, idToken: "not-a-firebase-token" });
  assert.equal(bad.status, 400);
  const none = await api(app.base, "/auth/link/phone", { linkCode: first.linkCode });
  assert.equal(none.status, 400);
  // a demo OTP code is not accepted as proof
  const demo = await api(app.base, "/auth/link/phone", { linkCode: first.linkCode, phone: victim.phone, code: "000000" });
  assert.equal(demo.status, 400);
  assert.equal(store.findIdentity("google", sub), null);

  // no link code → nothing to link
  assert.equal((await api(app.base, "/auth/link/phone", { idToken: fbToken(victim.phone) })).status, 400);
  // a Settings link intent can't be replayed as a pending-link code (and vice versa)
  const st = await api(app.base, "/auth/link/start", { provider: "google" }, { token: victim.access });
  const intent = new URLSearchParams(st.data.url.split("?")[1]).get("intent");
  assert.equal((await api(app.base, "/auth/link/phone", { linkCode: intent, idToken: fbToken(victim.phone) })).status, 400);

  // verified number with no account → refused, a fresh code is handed back, still nothing linked
  const nobody = await api(app.base, "/auth/link/phone", { linkCode: first.linkCode, idToken: fbToken(phoneNo()) });
  assert.equal(nobody.status, 404);
  assert.equal(nobody.data.code, "no_account");
  assert.ok(nobody.data.linkCode && nobody.data.linkCode !== first.linkCode);
  assert.equal(store.findIdentity("google", sub), null);
  // ...and the fresh code works once the right phone is proven
  const ok = await api(app.base, "/auth/link/phone", { linkCode: nobody.data.linkCode, idToken: fbToken(victim.phone) });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.id, victim.id);
  // a pending-link code can't be used as a Settings link intent either
  const other = await googleNew("g-" + uniq());
  const replay = await fetch(`${app.base}/auth/google/start?intent=${encodeURIComponent(other.linkCode)}`, { redirect: "manual" });
  assert.match(replay.headers.get("location") ?? "", /error=expired/);
  victim.client.close();
});

test("empty duplicate: Settings → Connect Google moves the identity to the phone account and deletes the empty duplicate", async () => {
  const donny = await phoneMember("Donny");
  const sub = "g-" + uniq();
  // the old behaviour: Google sign-in → brand-new (empty) account
  const first = await googleNew(sub);
  const dup = await registerTicket(app.wsUrl, first.ticket, { firstName: "Donny", username: `donnyg_${uniq()}` });
  assert.equal(dup.res.ok, true);
  const dupId = dup.res.user.id as string;
  dup.client.close();
  assert.equal(store.findIdentity("google", sub)?.userId, dupId);

  const st = await api(app.base, "/auth/link/start", { provider: "google" }, { token: donny.access });
  const r = await oauthRoundTrip(app, mock, "google", { sub, email: `${sub}@gmail.com`, email_verified: true }, { query: st.data.url.split("?")[1] });
  assert.equal(r.stage, "exchange", JSON.stringify(r));
  if (r.stage !== "exchange") return;
  assert.equal(r.exchange.data.status, "linked");
  assert.equal(store.findIdentity("google", sub)?.userId, donny.id);
  assert.equal(store.users.has(dupId), false, "empty duplicate deleted");
  await store.flush();
  assert.equal((await sql("SELECT 1 FROM users WHERE id=$1", [dupId])).length, 0);
  assert.equal((await sql<{ user_id: string }>("SELECT user_id FROM auth_identities WHERE provider='google' AND provider_subject=$1", [sub]))[0]?.user_id, donny.id);
  const g = await googleNew(sub);
  assert.equal(g.status, "existing");
  assert.equal(g.user.id, donny.id);
  donny.client.close();
});

test("empty duplicate created while the link step was open: phone verification takes it over", async () => {
  const donny = await phoneMember("Donny");
  const sub = "g-" + uniq();
  const tab1 = await googleNew(sub);
  const tab2 = await googleNew(sub); // second tab: creates the account
  const dup = await registerTicket(app.wsUrl, tab2.ticket, { firstName: "Donny", username: `donnyg_${uniq()}` });
  const dupId = dup.res.user.id as string;
  dup.client.close();
  const linked = await api(app.base, "/auth/link/phone", { linkCode: tab1.linkCode, idToken: fbToken(donny.phone) });
  assert.equal(linked.status, 200, JSON.stringify(linked.data));
  assert.equal(linked.data.user.id, donny.id);
  assert.equal(linked.data.removedDuplicate, true);
  assert.equal(store.users.has(dupId), false);
  assert.equal(store.findIdentity("google", sub)?.userId, donny.id);
  donny.client.close();
});

test("non-empty duplicate (has follows / DMs): refused with a clear message, nothing moved or deleted", async () => {
  const donny = await phoneMember("Donny");
  const friend = await phoneMember("Fran");
  const sub = "g-" + uniq();
  const first = await googleNew(sub);
  const dup = await registerTicket(app.wsUrl, first.ticket, { firstName: "Donny", username: `donnyg_${uniq()}` });
  const dupId = dup.res.user.id as string;
  assert.equal((await dup.client.req("user:follow", { userId: friend.id, follow: true })).ok, true);
  dup.client.close();

  const st = await api(app.base, "/auth/link/start", { provider: "google" }, { token: donny.access });
  const r = await oauthRoundTrip(app, mock, "google", { sub, email_verified: true, email: `${sub}@gmail.com` }, { query: st.data.url.split("?")[1] });
  assert.equal(r.stage, "callback");
  if (r.stage === "callback") assert.equal(r.error, "taken");
  assert.equal(store.findIdentity("google", sub)?.userId, dupId);
  assert.equal(store.users.has(dupId), true);

  // the sign-in link step refuses too (pending code for a NEW Apple identity on a dup with a DM)
  const asub = "001." + uniq();
  const ar = await oauthRoundTrip(app, mock, "apple", { sub: asub });
  if (ar.stage !== "exchange") throw new Error("no exchange");
  const adup = await registerTicket(app.wsUrl, ar.exchange.data.ticket, { firstName: "D", username: `da_${uniq()}` });
  // register created it; give it data, then try to link the (now taken) identity via the pending code
  assert.equal((await adup.client.req("dm:send", { to: friend.id, text: "hi from my apple account" })).ok, true);
  adup.client.close();
  const refused = await api(app.base, "/auth/link/phone", { linkCode: ar.exchange.data.linkCode, idToken: fbToken(donny.phone) });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, "taken");
  assert.match(refused.data.error, /messages, rooms or follows/);
  assert.equal(store.findIdentity("apple", asub)?.userId, adup.res.user.id);
  assert.equal(store.users.has(adup.res.user.id), true);
  for (const c of [donny.client, friend.client]) c.close();
});
