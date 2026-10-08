// Account deletion (App Store 5.1.1(v)): POST /api/me/delete { confirm: "DELETE" } removes the member's sessions,
// identities, device tokens, contact hashes, notification prefs and follows (both directions), anonymises their DMs
// and rooms, and the phone can sign up again as a brand-new member afterwards.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTestEnv, startApp, wipeDb, api, phoneLogin, sql, type App } from "./harness";

setTestEnv({ providers: false });
let app: App;
const uniq = () => randomBytes(3).toString("hex");

before(async () => {
  await wipeDb();
  app = await startApp();
});
after(async () => app?.close());

test("delete account wipes personal data and anonymises shared content", async () => {
  const { store } = await import("../../server/store");
  (await import("../../server/push")).initPush();
  const phoneA = `+1555555${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const phoneB = `+1555556${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const a = await phoneLogin(app.wsUrl, phoneA, { firstName: "Gone", username: `gone_${uniq()}` });
  const b = await phoneLogin(app.wsUrl, phoneB, { firstName: "Stay", username: `stay_${uniq()}` });
  const aid = a.res.user.id as string, bid = b.res.user.id as string;
  const tok = a.res.access as string;

  assert.equal((await a.client.req("user:follow", { userId: bid, follow: true })).ok, true);
  assert.equal((await b.client.req("user:follow", { userId: aid, follow: true })).ok, true);
  assert.equal((await a.client.req("dm:send", { to: bid, text: "hello from a soon-deleted account" })).ok, true);
  assert.equal((await api(app.base, "/api/push/register", { token: `fcm-${randomBytes(16).toString("hex")}`, platform: "android" }, { token: tok })).status, 200);
  assert.equal((await api(app.base, "/api/notifications/prefs", { dm: false }, { token: tok })).status, 200);
  await sql("INSERT INTO contact_hashes (owner_id, hash) VALUES ($1, $2)", [aid, randomBytes(16).toString("hex")]);
  await store.flush();

  // confirmation is required, auth is required
  assert.equal((await api(app.base, "/api/me/delete", {}, { token: tok })).status, 400);
  assert.equal((await api(app.base, "/api/me/delete", { confirm: "DELETE" })).status, 401);

  // re-verification is required (store compliance): a fresh sign-in (< 10 min) counts as proof
  assert.equal((await api(app.base, "/api/me/delete", { confirm: "DELETE" }, { token: tok })).status, 403);
  const reauth = (await api(app.base, "/api/me/delete/verify", { method: "recent" }, { token: tok })).data.reauth;
  const del = await api(app.base, "/api/me/delete", { confirm: "DELETE", reauth }, { token: tok });
  assert.equal(del.status, 200, JSON.stringify(del.data));
  await store.flush();

  // the old token no longer works
  assert.equal((await api(app.base, "/api/me/social-links", { links: {} }, { token: tok })).status, 401);
  // DB: personal rows gone
  for (const [t, col] of [["sessions", "user_id"], ["auth_identities", "user_id"], ["follows", "follower_id"], ["follows", "followee_id"], ["device_tokens", "user_id"], ["notification_prefs", "user_id"], ["contact_hashes", "owner_id"]]) {
    const r = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM ${t} WHERE ${col} = $1`, [aid]);
    assert.equal(r[0].n, "0", `${t}.${col} still has rows`);
  }
  // the users row is a scrubbed tombstone (deleted_at set, no PII) so their messages still render as "Deleted Account"
  const tomb = await sql<{ name: string; phone: string | null; deleted_at: string | null }>("SELECT name, phone, deleted_at FROM users WHERE id = $1", [aid]);
  assert.equal(tomb.length, 1);
  assert.equal(tomb[0].name, "Deleted Account");
  assert.equal(tomb[0].phone, null);
  assert.ok(tomb[0].deleted_at);
  // DMs kept for the other person, anonymised
  const dms = await sql<{ from_name: string }>("SELECT from_name FROM dms WHERE from_id = $1", [aid]);
  assert.ok(dms.length >= 1);
  for (const d of dms) assert.equal(d.from_name, "Deleted Account");
  assert.equal(store.users.has(aid), false);
  assert.equal(store.users.has(bid), true);

  // the phone number is free again: signing in creates a new member
  const again = await phoneLogin(app.wsUrl, phoneA, { firstName: "New", username: `new_${uniq()}` });
  assert.equal(again.created, true);
  assert.notEqual(again.res.user.id, aid);
  a.client.close(); b.client.close(); again.client.close();
});
