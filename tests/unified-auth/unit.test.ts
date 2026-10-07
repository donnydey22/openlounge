// Unit tests (no database): password hashing, JOSE helpers, linking rules on an in-memory Store,
// rate limiter, provider flags, mail templates / SMTP fallback.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { makeEcSigner, makeRsaSigner } from "./harness";

const ENV = process.env as Record<string, string | undefined>;
ENV.NODE_ENV = "test";
delete process.env.DATABASE_URL;

test("password: scrypt hash/verify, malformed hashes, policy", async () => {
  const { hashPassword, verifyPassword, needsRehash, passwordProblem } = await import("../../server/authx/password");
  const h = await hashPassword("correct horse battery");
  assert.match(h, /^scrypt\$32768\$8\$1\$[\w-]{22}\$[\w-]{86}$/);
  assert.equal(await verifyPassword("correct horse battery", h), true);
  assert.equal(await verifyPassword("correct horse batterY", h), false);
  assert.equal(await verifyPassword("x", "not-a-hash"), false);
  assert.equal(await verifyPassword("x", null), false);
  assert.notEqual(await hashPassword("same"), await hashPassword("same"), "salted");
  assert.equal(needsRehash(h), false);
  assert.equal(needsRehash("scrypt$16384$8$1$a$b"), true);
  assert.equal(passwordProblem("short"), "Use at least 8 characters.");
  assert.equal(passwordProblem("        "), "Your password can't be only spaces.");
  assert.equal(passwordProblem("x".repeat(201)), "Use at most 200 characters.");
  assert.equal(passwordProblem("long enough"), null);
});

async function jwksServer(keys: object[]) {
  let hits = 0;
  const s = http.createServer((_q, r) => (hits++, r.writeHead(200, { "Content-Type": "application/json" }), r.end(JSON.stringify({ keys }))));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/jwks`, close: () => s.close(), hits: () => hits };
}

test("verifyIdToken: RS256 + ES256 via JWKS; iss/aud/exp/nonce/signature/kid enforced", async () => {
  const { verifyIdToken, clearJwksCache, claimTrue } = await import("../../server/authx/jwt");
  const rsa = makeRsaSigner("r1");
  const ec = makeEcSigner("e1");
  const attacker = makeRsaSigner("r1"); // same kid, different key
  const srv = await jwksServer([rsa.jwk, ec.jwk]);
  clearJwksCache();
  const now = Math.floor(Date.now() / 1000);
  const base = { iss: "https://accounts.google.com", aud: "cid", sub: "123", iat: now, exp: now + 300, nonce: "n1" };
  const opts = { jwksUrl: srv.url, issuers: ["https://accounts.google.com"], audience: "cid", nonce: "n1" };
  assert.equal((await verifyIdToken(rsa.sign(base), opts)).sub, "123");
  assert.equal((await verifyIdToken(ec.sign(base), opts)).sub, "123");
  assert.equal(srv.hits(), 1, "JWKS cached");
  const bad = async (tok: string, re: RegExp, o = opts) => assert.rejects(verifyIdToken(tok, o), re);
  await bad(attacker.sign(base), /bad signature/);
  await bad(rsa.sign({ ...base, iss: "https://evil" }), /wrong issuer/);
  await bad(rsa.sign({ ...base, aud: "other" }), /wrong audience/);
  await bad(rsa.sign({ ...base, exp: now - 120 }), /expired/);
  await bad(rsa.sign({ ...base, nonce: "n2" }), /nonce mismatch/);
  await bad(rsa.sign(base, { kid: "unknown" }), /unknown kid/);
  await bad("a.b", /malformed/);
  const [h, p] = rsa.sign(base).split(".");
  const noneAlg = `${Buffer.from(JSON.stringify({ alg: "none", kid: "r1" })).toString("base64url")}.${p}.`;
  await bad(noneAlg, /unsupported alg/);
  void h;
  assert.equal(claimTrue("true"), true);
  assert.equal(claimTrue(true), true);
  assert.equal(claimTrue("false"), false);
  assert.equal(claimTrue(undefined), false);
  srv.close();
});

test("Apple client secret: ES256 JWT from a .p8 (PEM, escaped \\n, or bare base64)", async () => {
  const { parseP8, signEs256 } = await import("../../server/authx/jwt");
  const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = kp.privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const bare = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  for (const raw of [pem, pem.replace(/\n/g, "\\n"), bare]) {
    const key = parseP8(raw);
    const jwt = signEs256({ kid: "K1" }, { iss: "9A6NA2ZAFH", sub: "app.openlounge.web" }, key);
    const [h, p, s] = jwt.split(".");
    assert.equal(JSON.parse(Buffer.from(h, "base64url").toString()).alg, "ES256");
    assert.ok(cryptoVerify("SHA256", Buffer.from(`${h}.${p}`), { key: kp.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
  }
});

test("linking rules (in-memory store): identity match, verified-email link, unverified never links, ambiguity, Settings link", async () => {
  const { Store } = await import("../../server/store");
  const { resolveSignIn, linkToUser } = await import("../../server/authx/accounts");
  const s = new Store();
  const mk = (phone: string | null, username: string, identity?: NonNullable<Parameters<typeof s.createAccount>[2]>["identity"]) => {
    const r = s.createAccount(phone, { firstName: username, username }, { identity });
    assert.ok(r.ok, JSON.stringify(r));
    return r.user.id;
  };
  const phoneUser = mk("+14155550001", "phoneuser");
  assert.equal(s.findIdentity("phone", "+14155550001")?.userId, phoneUser, "phone signups create a phone identity");
  assert.equal(s.userByPhone("+14155550001")?.id, phoneUser);
  const emailUser = mk(null, "emailuser", { provider: "email", subject: "ann@example.com", email: "ann@example.com", verified: true });

  // 1. known identity
  const g1 = resolveSignIn(s, { provider: "google", subject: "g1", email: null, emailVerified: false });
  assert.equal(g1.kind, "new");
  // 2. verified email match → link (case-insensitive)
  const g2 = resolveSignIn(s, { provider: "google", subject: "g2", email: "ANN@example.com", emailVerified: true });
  assert.deepEqual(g2, { kind: "existing", userId: emailUser, via: "verified_email" });
  assert.deepEqual(resolveSignIn(s, { provider: "google", subject: "g2", email: null, emailVerified: false }), { kind: "existing", userId: emailUser, via: "identity" });
  // 3. unverified email never links
  const g3 = resolveSignIn(s, { provider: "google", subject: "g3", email: "ann@example.com", emailVerified: false });
  assert.equal(g3.kind, "new");
  if (g3.kind === "new") assert.equal(g3.identity.verified, false);
  // a verified email that only matches an UNVERIFIED identity doesn't link either
  const unv = mk(null, "unverified", { provider: "google", subject: "g-unv", email: "bob@example.com", verified: false });
  assert.equal(resolveSignIn(s, { provider: "apple", subject: "a1", email: "bob@example.com", emailVerified: true }).kind, "new");
  void unv;
  // ambiguity: two accounts with the same verified email → never guess
  mk(null, "dup1", { provider: "apple", subject: "a-d1", email: "dup@example.com", verified: true });
  mk(null, "dup2", { provider: "google", subject: "g-d2", email: "dup@example.com", verified: true });
  assert.equal(resolveSignIn(s, { provider: "email", subject: "dup@example.com", email: "dup@example.com", emailVerified: true }).kind, "new");

  // Settings link
  assert.deepEqual(linkToUser(s, phoneUser, { provider: "apple", subject: "a-p", email: null, emailVerified: false }), { ok: true, already: false });
  assert.deepEqual(linkToUser(s, phoneUser, { provider: "apple", subject: "a-p", email: null, emailVerified: false }), { ok: true, already: true });
  const taken = linkToUser(s, emailUser, { provider: "apple", subject: "a-p", email: null, emailVerified: false });
  assert.equal(taken.ok, false);
  // phone: one per account, never someone else's
  assert.equal(s.addIdentity(emailUser, { provider: "phone", subject: "+14155550001", verified: true }).ok, false);
  assert.equal(s.addIdentity(emailUser, { provider: "phone", subject: "+14155550002", verified: true }).ok, true);
  assert.equal(s.userByPhone("+14155550002")?.id, emailUser);
  assert.equal(s.addIdentity(emailUser, { provider: "phone", subject: "+14155550003", verified: true }).ok, false);
  // duplicate signup for an existing identity is refused
  assert.equal(s.createAccount(null, { firstName: "x", username: "xxx_dupe" }, { identity: { provider: "google", subject: "g2", verified: true } }).ok, false);
  // removal keeps at least one method; removing phone clears users.phone
  assert.equal(s.removeIdentity(emailUser, "phone", "+14155550002").ok, true);
  assert.equal(s.users.get(emailUser)!.phone, undefined);
  const only = mk(null, "onlyone", { provider: "apple", subject: "a-only", email: null, verified: false });
  assert.equal(s.removeIdentity(only, "apple", "a-only").ok, false);
});

test("legacy users (pre-005 snapshot: phone on users only) get phone identities on load", async () => {
  const { Store } = await import("../../server/store");
  const s = new Store();
  // @ts-expect-error private
  s.hydrate({ version: 1, users: [{ id: "u_legacy", name: "Leg", username: "leg", color: "#000", bio: "", isBot: false, createdAt: 1, baseFollowers: 0, baseFollowing: 0, phone: "+14155559999" }], follows: {}, rooms: [] }, "test");
  assert.equal(s.findIdentity("phone", "+14155559999")?.userId, "u_legacy");
  assert.equal(s.userByPhone("+14155559999")?.id, "u_legacy");
});

test("rate limiter: sliding window", async () => {
  const { allow, peekAllowed, resetRateLimits } = await import("../../server/authx/ratelimit");
  resetRateLimits();
  const lim = { max: 3, windowMs: 1000 };
  assert.deepEqual([1, 2, 3, 4].map(() => allow("k", lim, 10_000)), [true, true, true, false]);
  assert.equal(peekAllowed("k", lim, 10_500), false);
  assert.equal(allow("k", lim, 11_001), true, "window slid");
  assert.equal(allow("other", lim, 10_000), true, "keys are independent");
});

test("provider flags: each provider only with all its env vars; email via SMTP or dev flag only", async () => {
  const { providerFlags } = await import("../../server/authx/providers");
  const keys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "APPLE_TEAM_ID", "APPLE_SERVICES_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY", "SMTP_HOST", "SMTP_FROM", "AUTH_EMAIL_DEV"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    assert.deepEqual(providerFlags(), { phone: true, email: false, google: false, apple: false });
    process.env.GOOGLE_CLIENT_ID = "id";
    assert.equal(providerFlags().google, false, "secret missing");
    process.env.GOOGLE_CLIENT_SECRET = "s";
    assert.equal(providerFlags().google, true);
    Object.assign(process.env, { APPLE_TEAM_ID: "9A6NA2ZAFH", APPLE_SERVICES_ID: "x", APPLE_KEY_ID: "k", APPLE_PRIVATE_KEY: "not a key" });
    assert.equal(providerFlags().apple, false, "unparseable key keeps Apple off");
    process.env.APPLE_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    assert.equal(providerFlags().apple, true);
    process.env.SMTP_HOST = "smtp.example";
    assert.equal(providerFlags().email, false, "SMTP_FROM missing");
    process.env.SMTP_FROM = "a@b.c";
    assert.equal(providerFlags().email, true);
    delete process.env.SMTP_HOST;
    process.env.AUTH_EMAIL_DEV = "1";
    assert.equal(providerFlags().email, true);
    ENV.NODE_ENV = "production";
    assert.equal(providerFlags().email, false, "AUTH_EMAIL_DEV is ignored in production");
  } finally {
    ENV.NODE_ENV = "test";
    for (const k of keys) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  }
});

test("mail: templates are branded, escape input, carry the link; no SMTP → no throw", async () => {
  const { verifyEmailMail, resetPasswordMail, sendMail, maskEmail } = await import("../../server/authx/mailer");
  const m = resetPasswordMail("a@b.co", "https://openlounge.app/reset-password?token=abc&x=<y>", true);
  assert.match(m.html, /Open Lounge/);
  assert.match(m.html, /token=abc&amp;x=&lt;y&gt;/);
  assert.match(m.text, /https:\/\/openlounge\.app\/reset-password\?token=abc&x=<y>/);
  assert.match(m.text, /30 minutes/);
  const v = verifyEmailMail("a@b.co", "https://openlounge.app/verify-email?token=t", false);
  assert.equal(v.subject, "Confirm your email for Open Lounge");
  delete process.env.SMTP_HOST;
  assert.equal(await sendMail(v), false);
  assert.equal(maskEmail("jordan@example.com"), "j*****@example.com");
});
