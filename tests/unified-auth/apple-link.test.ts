// Sign in with Apple unifies with existing phone accounts exactly like Google — generically, for ANY member.
// Several distinct members (each with their own phone) link Apple and Google; nothing ever crosses accounts.
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
const fbToken = (phone: string) => `fb:${phone}`;
const relay = () => `${uniq()}${uniq()}@privaterelay.appleid.com`;

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

async function signIn(provider: "google" | "apple", claims: Record<string, unknown>) {
  const r = await oauthRoundTrip(app, mock, provider, claims);
  assert.equal(r.stage, "exchange", JSON.stringify(r));
  if (r.stage !== "exchange") throw new Error("no exchange");
  return r.exchange.data;
}

async function connectFromSettings(provider: "google" | "apple", access: string, claims: Record<string, unknown>) {
  const st = await api(app.base, "/auth/link/start", { provider }, { token: access });
  assert.equal(st.status, 200, JSON.stringify(st.data));
  return oauthRoundTrip(app, mock, provider, claims, { query: st.data.url.split("?")[1] });
}

const ownerRows = async (provider: string, sub: string) =>
  (await sql<{ user_id: string }>("SELECT user_id FROM auth_identities WHERE provider=$1 AND provider_subject=$2", [provider, sub])).map((r) => r.user_id);

test("Settings → Connect Apple: each member's Apple attaches to THEIR OWN user id; later sign-ins without email land there", async () => {
  const members = [await phoneMember("Ana"), await phoneMember("Ben"), await phoneMember("Cy")];
  const subs = members.map(() => "001." + uniq());
  for (const [i, m] of members.entries()) {
    const r = await connectFromSettings("apple", m.access, { sub: subs[i], email: relay(), email_verified: "true" });
    assert.equal(r.stage, "exchange", JSON.stringify(r));
    if (r.stage === "exchange") assert.equal(r.exchange.data.status, "linked");
  }
  await store.flush();
  for (const [i, m] of members.entries()) {
    assert.equal(store.findIdentity("apple", subs[i])?.userId, m.id);
    assert.deepEqual(await ownerRows("apple", subs[i]), [m.id]);
    // Apple omits email on later sign-ins: `sub` alone finds the same account, email kept
    const before = store.findIdentity("apple", subs[i])!.email;
    const again = await signIn("apple", { sub: subs[i] });
    assert.equal(again.status, "existing");
    assert.equal(again.user.id, m.id);
    assert.equal(store.findIdentity("apple", subs[i])?.email, before, "email not wiped when absent");
  }
  // another member can't grab an Apple ID that belongs to a real (phone) account
  const steal = await connectFromSettings("apple", members[1].access, { sub: subs[0] });
  assert.equal(steal.stage, "callback");
  if (steal.stage === "callback") assert.equal(steal.error, "taken");
  assert.equal(store.findIdentity("apple", subs[0])?.userId, members[0].id);
  assert.ok(store.users.has(members[0].id));
  for (const m of members) m.client.close();
});

test("Apple + Google sign-in → 'Verify my phone' links each member to their own phone account, no crossover", async () => {
  const members = [await phoneMember("Dee"), await phoneMember("Eli")];
  const apple = members.map(() => "001." + uniq());
  const google = members.map(() => "g-" + uniq());
  for (const [i, m] of members.entries()) {
    const a = await signIn("apple", { sub: apple[i], email: relay(), email_verified: "true" });
    assert.equal(a.status, "new");
    assert.ok(a.linkCode);
    const la = await api(app.base, "/auth/link/phone", { linkCode: a.linkCode, idToken: fbToken(m.phone) });
    assert.equal(la.status, 200, JSON.stringify(la.data));
    assert.equal(la.data.user.id, m.id);
    assert.equal(la.data.linked, "apple");

    const g = await signIn("google", { sub: google[i], email: `${google[i]}@gmail.com`, email_verified: true });
    assert.equal(g.status, "new");
    const lg = await api(app.base, "/auth/link/phone", { linkCode: g.linkCode, idToken: fbToken(m.phone) });
    assert.equal(lg.status, 200, JSON.stringify(lg.data));
    assert.equal(lg.data.user.id, m.id);
  }
  await store.flush();
  for (const [i, m] of members.entries()) {
    assert.deepEqual(await ownerRows("apple", apple[i]), [m.id]);
    assert.deepEqual(await ownerRows("google", google[i]), [m.id]);
    const a2 = await signIn("apple", { sub: apple[i] }); // no email this time
    assert.equal(a2.user.id, m.id);
    const g2 = await signIn("google", { sub: google[i], email: `${google[i]}@gmail.com`, email_verified: true });
    assert.equal(g2.user.id, m.id);
    // all data kept: same profile
    assert.equal(store.users.get(m.id)?.phone, m.phone);
  }
  for (const m of members) m.client.close();
});

test("empty Apple duplicate is taken over (Settings and verify-phone paths)", async () => {
  const m1 = await phoneMember("Fay");
  const m2 = await phoneMember("Gus");
  // m1: duplicate created first, then Settings → Connect Apple
  const s1 = "001." + uniq();
  const d1 = await signIn("apple", { sub: s1, email: relay(), email_verified: true });
  const dup1 = await registerTicket(app.wsUrl, d1.ticket, { firstName: "Fay", username: `faya_${uniq()}` });
  const dup1Id = dup1.res.user.id as string;
  dup1.client.close();
  const r = await connectFromSettings("apple", m1.access, { sub: s1 });
  assert.equal(r.stage, "exchange", JSON.stringify(r));
  assert.equal(store.findIdentity("apple", s1)?.userId, m1.id);
  assert.equal(store.users.has(dup1Id), false);
  // m2: two tabs, one creates the duplicate, other verifies phone
  const s2 = "001." + uniq();
  const tab1 = await signIn("apple", { sub: s2, email: relay(), email_verified: true });
  const tab2 = await signIn("apple", { sub: s2 });
  const dup2 = await registerTicket(app.wsUrl, tab2.ticket, { firstName: "Gus", username: `gusa_${uniq()}` });
  const dup2Id = dup2.res.user.id as string;
  dup2.client.close();
  const l = await api(app.base, "/auth/link/phone", { linkCode: tab1.linkCode, idToken: fbToken(m2.phone) });
  assert.equal(l.status, 200, JSON.stringify(l.data));
  assert.equal(l.data.user.id, m2.id);
  assert.equal(l.data.removedDuplicate, true);
  assert.equal(store.users.has(dup2Id), false);
  assert.equal(store.findIdentity("apple", s1)?.userId, m1.id, "m1 untouched");
  for (const c of [m1.client, m2.client]) c.close();
});

test("relay email: stored on the identity; verified only if Apple says so; unverified never matches another account", async () => {
  // a Google account that verified some address
  const shared = relay();
  const gsub = "g-" + uniq();
  const g = await signIn("google", { sub: gsub, email: shared, email_verified: true });
  const gReg = await registerTicket(app.wsUrl, g.ticket, { firstName: "Hal", username: `hal_${uniq()}` });
  const gId = gReg.res.user.id as string;
  gReg.client.close();

  // Apple with the same address but NOT verified → no match, brand-new choice
  const s1 = "001." + uniq();
  const a1 = await signIn("apple", { sub: s1, email: shared, email_verified: "false" });
  assert.equal(a1.status, "new");
  assert.equal(store.findIdentity("apple", s1), null);
  const reg = await registerTicket(app.wsUrl, a1.ticket, { firstName: "Ivy", username: `ivy_${uniq()}` });
  assert.equal(reg.res.ok, true);
  assert.notEqual(reg.res.user.id, gId);
  const idn = store.findIdentity("apple", s1)!;
  assert.equal(idn.email, shared, "relay address stored as identity email");
  assert.equal(idn.verified, false);
  reg.client.close();

  // Apple says verified → stored verified
  const m = await phoneMember("Jo");
  const s2 = "001." + uniq();
  const r2 = relay();
  await connectFromSettings("apple", m.access, { sub: s2, email: r2.toUpperCase(), email_verified: true });
  const i2 = store.findIdentity("apple", s2)!;
  assert.equal(i2.userId, m.id);
  assert.equal(i2.email, r2);
  assert.equal(i2.verified, true);
  const ids = await api(app.base, "/auth/identities", undefined, { token: m.access, method: "GET" });
  if (ids.status === 200) assert.ok(JSON.stringify(ids.data).includes('"privateRelay":true'));
  m.client.close();
});

test("server code never special-cases a user id or phone number", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["accounts.ts", "routes.ts"]) {
    const src = readFileSync(new URL(`../../server/authx/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\+\d{10,}/, `${f}: hardcoded phone`);
    assert.doesNotMatch(src, /(userId|\.id)\s*===?\s*["'`]/, `${f}: hardcoded user id`);
  }
});
