// Persistent sessions: the httpOnly ol_rt cookie mirrors the refresh token so a session survives web-storage
// eviction; it slides on every refresh; logout and account deletion still revoke it. Firebase is not involved
// after the initial sign-in (the session is entirely ours).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTestEnv, startApp, wipeDb, phoneLogin, type App } from "./harness";

setTestEnv({ providers: false });
let app: App;
let REFRESH_TTL_MS = 0;
let readRefreshCookie: typeof import("../../server/auth").readRefreshCookie;
before(async () => {
  await wipeDb();
  ({ REFRESH_TTL_MS, readRefreshCookie } = await import("../../server/auth"));
  app = await startApp();
});
after(async () => {
  await app?.close();
});

const phoneNo = () => `+1415${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
const post = (p: string, body: unknown, cookie?: string) =>
  fetch(`${app.base}${p}`, { method: "POST", headers: { "Content-Type": "application/json", Connection: "close", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const cookieFrom = (r: Response) => {
  const sc = r.headers.get("set-cookie") ?? "";
  const v = readRefreshCookie(sc.split(";")[0]);
  return { raw: sc, value: v, header: v ? `ol_rt=${encodeURIComponent(v)}` : "" };
};

test("refresh TTL is long (>= 1 year) and sliding", () => {
  assert.ok(REFRESH_TTL_MS >= 365 * 24 * 60 * 60_000);
});

test("persist → cookie; storage wiped → cookie alone restores the same user; rotation keeps cookie current", async () => {
  const su = await phoneLogin(app.wsUrl, phoneNo(), { firstName: "Per", username: `per_${Date.now().toString(36)}` });
  su.client.close();
  const uid = su.res.user.id;
  const p = await post("/api/auth/persist", { refreshToken: su.res.refresh });
  assert.equal(p.status, 200);
  const c1 = cookieFrom(p);
  assert.match(c1.raw, /HttpOnly/);
  assert.match(c1.raw, /SameSite=Lax/);
  assert.match(c1.raw, /Path=\/api\/auth/);
  assert.equal(c1.value, su.res.refresh);

  // web storage gone: refresh with only the cookie
  const r1 = await post("/api/auth/refresh", {}, c1.header);
  const d1 = await r1.json();
  assert.equal(r1.status, 200);
  assert.equal(d1.user.id, uid);
  const c2 = cookieFrom(r1);
  assert.equal(c2.value, d1.refresh, "cookie follows rotation");

  // the rotated cookie keeps working (sliding)
  const r2 = await post("/api/auth/refresh", {}, c2.header);
  assert.equal(r2.status, 200);
  const d2 = await r2.json();
  assert.equal(d2.user.id, uid);
  const c3 = cookieFrom(r2);

  // logout via cookie only → revoked + cookie cleared
  const lo = await post("/api/auth/logout", {}, c3.header);
  assert.equal(lo.status, 200);
  assert.match(lo.headers.get("set-cookie") ?? "", /Max-Age=0/);
  const r3 = await post("/api/auth/refresh", {}, c3.header);
  assert.equal(r3.status, 401);
  assert.match(r3.headers.get("set-cookie") ?? "", /Max-Age=0/, "rejected cookie is cleared");
});

test("persist rejects unknown tokens; no cookie + no body → 401", async () => {
  assert.equal((await post("/api/auth/persist", { refreshToken: "nope" })).status, 401);
  assert.equal((await post("/api/auth/refresh", {})).status, 401);
});

test("a stale body token never clears a good cookie", async () => {
  const su = await phoneLogin(app.wsUrl, phoneNo(), { firstName: "Sta", username: `sta_${Date.now().toString(36)}` });
  su.client.close();
  const c = cookieFrom(await post("/api/auth/persist", { refreshToken: su.res.refresh }));
  const bad = await post("/api/auth/refresh", { refreshToken: "garbage" }, c.header);
  assert.equal(bad.status, 401);
  assert.doesNotMatch(bad.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.equal((await post("/api/auth/refresh", {}, c.header)).status, 200);
});
