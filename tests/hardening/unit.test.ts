import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { configureAuthKeys, originAllowed, parseAccessToken, signAccessToken } from "../../server/auth";
import { BadJson, BodyTooLarge, RateLimiter, buildCsp, readJsonBody, securityHeaders, wwwRedirect } from "../../server/httpsec";
import { validateEvent } from "../../server/wsSchemas";
import { isTransientPgError, withRetry } from "../../server/pg";
import { Readable } from "node:stream";

const exp = () => Date.now() + 60_000;

test("auth: env AUTH_SECRET preferred over DB key, token carries kid", () => {
  const k = configureAuthKeys({ env: { AUTH_SECRET: "env-secret-aaaaaaaaaaaaaaaaaaaaaaaa" }, dbSecret: "db-secret" });
  assert.equal(k.signingSource, "env:AUTH_SECRET");
  const t = signAccessToken("s_1", exp());
  assert.equal(t.split(".").length, 5);
  assert.equal(t.split(".")[4], k.signingKid);
  const p = parseAccessToken(t);
  assert.ok(p.ok);
});

test("auth: falls back to DB key when AUTH_SECRET unset", () => {
  const k = configureAuthKeys({ env: {}, dbSecret: "db-secret" });
  assert.equal(k.signingSource, "db");
  assert.ok(parseAccessToken(signAccessToken("s_1", exp())).ok);
});

test("auth: cut-over — tokens signed with the DB key still verify after AUTH_SECRET is set (grace)", () => {
  configureAuthKeys({ env: {}, dbSecret: "db-secret" });
  const old = signAccessToken("s_1", exp());
  configureAuthKeys({ env: { AUTH_SECRET: "new-env" }, dbSecret: "db-secret" });
  assert.ok(parseAccessToken(old).ok);
  configureAuthKeys({ env: { AUTH_SECRET: "new-env", AUTH_SECRET_ACCEPT_DB: "0" }, dbSecret: "db-secret" });
  assert.deepEqual(parseAccessToken(old), { ok: false, reason: "invalid" });
});

test("auth: rotation via AUTH_SECRET_PREVIOUS; removed key stops verifying", () => {
  configureAuthKeys({ env: { AUTH_SECRET: "k1" } });
  const t1 = signAccessToken("s_1", exp());
  configureAuthKeys({ env: { AUTH_SECRET: "k2", AUTH_SECRET_PREVIOUS: "k1" } });
  assert.ok(parseAccessToken(t1).ok);
  assert.ok(parseAccessToken(signAccessToken("s_1", exp())).ok);
  configureAuthKeys({ env: { AUTH_SECRET: "k2" } });
  assert.equal(parseAccessToken(t1).ok, false);
});

test("auth: legacy 4-part tokens (no kid) verify against any known key", () => {
  configureAuthKeys({ env: { AUTH_SECRET: "k2", AUTH_SECRET_PREVIOUS: "legacy" } });
  const payload = `ol1.s_9.${exp().toString(36)}`;
  const sig = createHmac("sha256", Buffer.from("legacy")).update(payload).digest("base64url");
  assert.ok(parseAccessToken(`${payload}.${sig}`).ok);
  assert.equal(parseAccessToken(`${payload}.${sig}x`).ok, false);
});

test("auth: tampered / unknown kid / expired", () => {
  configureAuthKeys({ env: { AUTH_SECRET: "k" } });
  const t = signAccessToken("s_1", exp());
  assert.equal(parseAccessToken(t.replace("s_1", "s_2")).ok, false);
  assert.equal(parseAccessToken(t.slice(0, -8) + "deadbeef").ok, false);
  const e = parseAccessToken(signAccessToken("s_1", Date.now() - 1));
  assert.deepEqual(e, { ok: false, reason: "expired", sessionId: "s_1" });
});

test("cors: allowlist, same-origin, app schemes, foreign origin", () => {
  assert.ok(originAllowed("https://openlounge.app", "x"));
  assert.ok(originAllowed(undefined, "x"));
  assert.ok(originAllowed("http://localhost:3000", "localhost:3000"));
  assert.ok(originAllowed("capacitor://localhost", "openlounge.app"));
  assert.ok(originAllowed("openlounge://", "openlounge.app"));
  assert.equal(originAllowed("https://evil.example", "openlounge.app"), false);
  assert.equal(originAllowed("null", "openlounge.app"), false);
  assert.equal(originAllowed("https://openlounge.app.evil.com", "openlounge.app"), false);
});

test("csp: production policy covers LiveKit (self-hosted + cloud), Firebase, /ws; no unsafe-eval", () => {
  const csp = buildCsp({ LIVEKIT_URL: "wss://livekit-production-5c67.up.railway.app", LIVEKIT_CLOUD_URL: "wss://x.livekit.cloud" }, false);
  for (const s of ["wss://livekit-production-5c67.up.railway.app", "https://livekit-production-5c67.up.railway.app", "wss://x.livekit.cloud", "https://*.googleapis.com", "https://www.gstatic.com", "https://www.google.com/recaptcha/", "https://*.firebaseapp.com", "wss://openlounge.app", "frame-ancestors 'none'"])
    assert.ok(csp.includes(s), s);
  assert.ok(!csp.includes("unsafe-eval"));
  assert.ok(!csp.includes("raw.githubusercontent.com"), "Telegram remote emoji host must stay out of CSP");
  assert.ok(buildCsp({}, true).includes("'unsafe-eval'"));
});

test("headers: HSTS 1y includeSubDomains no preload; CSP_REPORT_ONLY toggles header name; dev has no HSTS", () => {
  const h = securityHeaders({ NODE_ENV: "production" }, false);
  assert.equal(h["Strict-Transport-Security"], "max-age=31536000; includeSubDomains");
  assert.ok(h["Content-Security-Policy"]);
  assert.match(h["Permissions-Policy"], /microphone=\(self\)/);
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.ok(h["Referrer-Policy"]);
  const r = securityHeaders({ CSP_REPORT_ONLY: "1" }, false);
  assert.ok(r["Content-Security-Policy-Report-Only"] && !r["Content-Security-Policy"]);
  assert.equal(securityHeaders({}, true)["Strict-Transport-Security"], undefined);
});

test("www redirect", () => {
  assert.equal(wwwRedirect("www.openlounge.app", "/room/1?x=2"), "https://openlounge.app/room/1?x=2");
  assert.equal(wwwRedirect("WWW.openlounge.app:443", "//evil.com"), "https://openlounge.app/");
  assert.equal(wwwRedirect("openlounge.app", "/"), null);
  assert.equal(wwwRedirect("www.evil.com", "/"), null);
});

const reqOf = (body: string, headers: Record<string, string> = {}) => Object.assign(Readable.from([Buffer.from(body)]), { headers }) as never;
test("body: size limit and JSON validation", async () => {
  assert.deepEqual(await readJsonBody(reqOf('{"a":1}')), { a: 1 });
  await assert.rejects(readJsonBody(reqOf("x".repeat(100)), 50), BodyTooLarge);
  await assert.rejects(readJsonBody(reqOf("{}", { "content-length": "999999" })), BodyTooLarge);
  await assert.rejects(readJsonBody(reqOf("{bad")), BadJson);
  await assert.rejects(readJsonBody(reqOf("[1]")), BadJson);
});

test("rate limiter: fixed window", () => {
  const rl = new RateLimiter(3, 1000);
  const t = 1_000_000;
  assert.deepEqual([1, 2, 3, 4].map(() => rl.take("ip", t)), [true, true, true, false]);
  assert.ok(rl.take("other", t));
  assert.ok(rl.take("ip", t + 1001));
});

test("ws schemas", () => {
  assert.equal(validateEvent("dm:send", { to: "u_1", text: "hi", clientId: "c-1" }), null);
  assert.match(String(validateEvent("dm:send", { to: "u_1", text: 5 })), /text/);
  assert.match(String(validateEvent("dm:send", { to: "../x y", text: "hi" })), /to/);
  assert.equal(validateEvent("dm:history", { peerId: "u_1", before: null }), null);
  assert.equal(validateEvent("podium:set", { roomId: "abc", userId: null }), null);
  assert.equal(validateEvent("hand:set", { roomId: "abc", raised: "yes" }), 'invalid field "raised"');
  assert.equal(validateEvent("rooms:list", undefined), null);
  assert.equal(validateEvent("dm:send", [1]), "data must be an object");
  assert.equal(validateEvent("new:event", {}), "unschematized");
  assert.equal(validateEvent("chat:send", { roomId: "a", text: "x".repeat(5000) }), 'invalid field "text"');
});

test("pg transient classification + retry", async () => {
  assert.ok(isTransientPgError({ code: "57P01" }));
  assert.ok(isTransientPgError(new Error("Connection terminated unexpectedly")));
  assert.equal(isTransientPgError({ code: "23505" }), false);
  let n = 0;
  assert.equal(await withRetry(async () => (++n < 3 ? Promise.reject(Object.assign(new Error("x"), { code: "40001" })) : "ok"), { baseMs: 1 }), "ok");
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(withRetry(async () => (n++, Promise.reject(Object.assign(new Error("dup"), { code: "23505" }))), { baseMs: 1 }));
  assert.equal(n, 1);
});
