// Store compliance: Telegram-style account deletion. Re-verification (password / email code / phone token / recent
// sign-in / app biometric), scrubbed users.deleted_at tombstone, "Deleted Account" ghost everywhere, DMs refused,
// hidden from search + suggestions, hosted rooms ended, push data erased, live user:deleted event, username freed,
// same-phone re-signup is a new unlinked account, and the tombstone survives a reload from Postgres.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import "./env";
import { setTestEnv, startApp, wipeDb, api, phoneLogin, sql, type App } from "../unified-auth/harness";

setTestEnv({ providers: false, dbUrl: process.env.TEST_DATABASE_URL });
const DB = () => process.env.TEST_DATABASE_URL!;
let app: App;
const uniq = () => randomBytes(3).toString("hex");
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
type Login = Awaited<ReturnType<typeof phoneLogin>>;
const open: Login[] = [];
const login = async (p = phone(), name = "User") => {
  const l = await phoneLogin(app.wsUrl, p, { firstName: name, username: `${name.toLowerCase()}_${uniq()}` });
  open.push(l);
  return l;
};
const tok = (x: Login) => x.res.access as string;
const verify = (x: Login, body: Record<string, unknown>) => api(app.base, "/api/me/delete/verify", body, { token: tok(x) });
const del = (x: Login, reauth?: string) => api(app.base, "/api/me/delete", { confirm: "DELETE", ...(reauth ? { reauth } : {}) }, { token: tok(x) });
/** make this login's session look old, so "recent sign-in" no longer counts */
async function age(x: Login) {
  const { store } = await import("../../server/store");
  for (const s of store.sessions.values()) if (s.userId === x.res.user.id) s.createdAt -= 60 * 60_000;
}

before(async () => {
  await sql("CREATE DATABASE store_test", [], "postgresql://ua@127.0.0.1:55433/postgres").catch(() => {});
  await wipeDb(DB());
  app = await startApp();
  (await import("../../server/push")).initPush();
});
after(async () => {
  const { setPhoneVerifier } = await import("../../server/firebase");
  setPhoneVerifier(null);
  for (const x of open) x.client.close();
  await app?.close();
});

test("re-verification is required; options reflect the account", async () => {
  const pA = phone();
  const a = await login(pA);
  assert.equal((await api(app.base, "/api/me/delete/options")).status, 401);
  const o = await api(app.base, "/api/me/delete/options", undefined, { token: tok(a) });
  assert.equal(o.status, 200);
  assert.equal(o.data.recent, true);
  assert.equal(o.data.password, false);
  assert.match(o.data.phone.masked, /\d{2}$/);
  assert.ok(!JSON.stringify(o.data).includes(pA.slice(-7)), "full phone is never returned");
  // no proof → 403 reauthRequired; a bogus proof → 403; wrong confirm → 400
  const r = await del(a);
  assert.equal(r.status, 403);
  assert.equal(r.data.reauthRequired, true);
  assert.equal((await del(a, "x".repeat(32))).status, 403);
  assert.equal((await api(app.base, "/api/me/delete", { confirm: "nope" }, { token: tok(a) })).status, 400);
  // an old session can't use "recent"
  await age(a);
  assert.equal((await verify(a, { method: "recent" })).status, 401);
  // app-only biometric isn't available to a web session
  assert.notEqual((await verify(a, { method: "device" })).status, 200);
});

test("password method (wrong password rejected; proof is single use)", async () => {
  const a = await login();
  const { store } = await import("../../server/store");
  const { hashPassword } = await import("../../server/authx/password");
  store.setPasswordHash(a.res.user.id, await hashPassword("correct horse battery staple"));
  await age(a);
  assert.equal((await verify(a, { method: "password", password: "wrong password!!" })).status, 401);
  const ok = await verify(a, { method: "password", password: "correct horse battery staple" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // a proof issued to someone else doesn't work
  const b = await login();
  assert.equal((await del(b, ok.data.reauth)).status, 403);
  assert.equal((await del(a, ok.data.reauth)).status, 200);
  assert.equal((await del(a, ok.data.reauth)).status, 401, "token is revoked after deletion");
});

test("email code method", async () => {
  const a = await login();
  const { store } = await import("../../server/store");
  const { outbox } = await import("../../server/authx/mailer");
  const email = `del_${uniq()}@example.com`;
  store.addIdentity(a.res.user.id, { provider: "email", subject: email, email, verified: true });
  await age(a);
  assert.equal((await api(app.base, "/api/me/delete/email/start", { email: "other@example.com" }, { token: tok(a) })).status, 400);
  const s = await api(app.base, "/api/me/delete/email/start", { email }, { token: tok(a) });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  const mail = outbox.filter((m) => m.to === email).at(-1)!;
  assert.match(mail.subject, /Open Lounge/);
  assert.equal((await verify(a, { method: "email", code: "000000" === mail.code ? "111111" : "000000" })).status, 401);
  const ok = await verify(a, { method: "email", code: mail.code });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await del(a, ok.data.reauth)).status, 200);
  // the email identity is gone: signing up with it again is a fresh account
  assert.equal(store.identitiesOf(a.res.user.id).length, 0);
});

test("phone token method must match the account's number", async () => {
  const p = phone();
  const a = await login(p);
  const { setPhoneVerifier } = await import("../../server/firebase");
  await age(a);
  setPhoneVerifier(async (t) => (t === "tok-other-xxxxxxxxxxxxxxxx" ? { ok: true, phone: "+15550000000", uid: "x" } : { ok: true, phone: p, uid: "y" }));
  const wrong = await verify(a, { method: "phone", idToken: "tok-other-xxxxxxxxxxxxxxxx" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.data.reauth, undefined);
  const ok = await verify(a, { method: "phone", idToken: "tok-mine-xxxxxxxxxxxxxxxxx" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await del(a, ok.data.reauth)).status, 200);
  setPhoneVerifier(null);
});

test("full deletion: tombstone, ghost everywhere, DMs refused, hidden, rooms ended, push erased, live event, re-signup", async () => {
  const { store } = await import("../../server/store");
  const pA = phone();
  const a = await login(pA, "Gone");
  const b = await login(phone(), "Stay");
  const aid = a.res.user.id as string, bid = b.res.user.id as string;
  const oldUsername = a.res.user.username as string;
  assert.equal((await a.client.req("user:follow", { userId: bid, follow: true })).ok, true);
  assert.equal((await b.client.req("user:follow", { userId: aid, follow: true })).ok, true);
  const dm = await a.client.req("dm:send", { to: bid, text: "hi before I go" });
  assert.equal(dm.ok, true);
  const room = await a.client.req("room:create", { title: "Gone's room" });
  assert.equal((await a.client.req("room:join", { roomId: room.roomId })).ok, true);
  assert.equal((await api(app.base, "/api/push/register", { token: `fcm-${randomBytes(16).toString("hex")}`, platform: "android" }, { token: tok(a) })).status, 200);
  await sql("INSERT INTO contact_hashes (owner_id, hash) VALUES ($1, $2)", [aid, randomBytes(16).toString("hex")], DB());
  await store.flush();

  // B listens for the live broadcast
  const events: { ev: string; data: { userId: string; user?: { name: string; deleted?: boolean } } }[] = [];
  b.client.ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "evt" && m.ev === "user:deleted") events.push(m);
  });

  const reauth = (await verify(a, { method: "recent" })).data.reauth;
  const r = await del(a, reauth);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await store.flush();
  for (let i = 0; i < 40 && !events.length; i++) await new Promise((res) => setTimeout(res, 50));
  assert.equal(events[0]?.data.userId, aid, "user:deleted broadcast");
  assert.equal(events[0]?.data.user?.name, "Deleted Account");

  // Postgres: scrubbed tombstone, personal rows gone
  const [t] = await sql<Record<string, unknown>>("SELECT name, username, phone, bio, photo_version, password_hash, social_links, deleted_at FROM users WHERE id = $1", [aid], DB());
  assert.equal(t.name, "Deleted Account");
  assert.notEqual(t.username, oldUsername);
  assert.equal(t.phone, null);
  assert.equal(t.bio, "");
  assert.equal(t.photo_version, null);
  assert.equal(t.password_hash, null);
  assert.ok(t.deleted_at);
  for (const [tbl, col] of [["sessions", "user_id"], ["auth_identities", "user_id"], ["follows", "follower_id"], ["follows", "followee_id"], ["device_tokens", "user_id"], ["contact_hashes", "owner_id"]]) {
    const n = await sql<{ n: string }>(`SELECT count(*)::text AS n FROM ${tbl} WHERE ${col} = $1`, [aid], DB());
    assert.equal(n[0].n, "0", `${tbl}.${col}`);
  }

  // ghost everywhere
  const pub = store.publicUser(aid)!;
  assert.equal(pub.name, "Deleted Account");
  assert.equal(pub.deleted, true);
  assert.equal(pub.photoUrl, null);
  const prof = await b.client.req("user:get", { userId: aid });
  assert.equal(prof.ok, true);
  assert.equal(prof.profile.user.deleted, true);
  assert.equal(prof.profile.followers.length, 0);
  const hist = await b.client.req("dm:history", { peerId: aid });
  assert.ok(hist.messages.some((m: { id: string; fromName?: string }) => m.id === dm.message.id), "their message stays in B's chat");
  for (const m of hist.messages) if (m.fromId === aid && "fromName" in m) assert.equal(m.fromName, "Deleted Account");

  // can't message a deleted account
  const send = await b.client.req("dm:send", { to: aid, text: "hello?" });
  assert.equal(send.ok, false);
  assert.match(String(send.error), /deleted account/i);

  // hidden from search / lists / suggestions; not followable
  const list = await b.client.req("users:list", {});
  assert.ok(!list.users.some((u: { id: string }) => u.id === aid));
  assert.ok(!store.suggestions(bid).some((u) => u.id === aid));
  assert.equal(store.setFollow(bid, aid, true), false);

  // hosted room ended
  assert.equal(store.rooms.get(room.roomId)?.ended ?? true, true);

  // username is free again; same phone → a brand-new, unlinked account
  const again = await phoneLogin(app.wsUrl, pA, { firstName: "New", username: oldUsername });
  open.push(again);
  assert.equal(again.created, true);
  assert.notEqual(again.res.user.id, aid);
  assert.equal(again.res.user.username, oldUsername);
  assert.equal(store.publicUser(aid)!.deleted, true, "old tombstone unaffected");

  // nobody can take the "Deleted Account" name
  const nm = await b.client.req("user:update", { name: "Deleted Account" });
  assert.equal(nm.ok, false);

  // tombstone survives a reload from Postgres
  await store.flush();
  const { PgPersistence } = await import("../../server/pg");
  const pp = new PgPersistence(DB());
  const loaded = (await pp.load()).db;
  const rec = loaded?.users.find((u) => u.id === aid);
  assert.ok(rec, "tombstone row loads");
  assert.ok(rec!.deletedAt);
});

test("operator deletion queue (account_deletion_requests): same deletion path, audited, idempotent", async () => {
  const { store } = await import("../../server/store");
  const { startDeletionQueue, processDeletionRequests, stopDeletionQueue } = await import("../../server/deletionQueue");
  const a = await login(phone(), "Queued");
  const keep = await login(phone(), "Keep");
  const aid = a.res.user.id as string;
  startDeletionQueue(60 * 60_000);
  await new Promise((r) => setTimeout(r, 200));
  await sql("INSERT INTO account_deletion_requests (user_id, requested_by, reason) VALUES ($1, 'test', 'close test account'), ($1, 'test', 'duplicate'), ('u_nope', 'test', 'missing')", [aid], DB());
  await processDeletionRequests();
  const rows = await sql<{ user_id: string; processed_at: string | null; result: string }>("SELECT user_id, processed_at, result FROM account_deletion_requests ORDER BY id", [], DB());
  assert.match(rows[0].result, /^deleted/);
  assert.equal(rows[1].result, "already deleted");
  assert.equal(rows[2].result, "not found");
  assert.ok(rows.every((r) => r.processed_at));
  assert.equal(store.publicUser(aid)!.deleted, true);
  assert.equal(store.users.has(keep.res.user.id), true, "other accounts untouched");
  assert.equal((await api(app.base, "/api/me/delete/options", undefined, { token: tok(a) })).status, 401, "sessions revoked");
  await stopDeletionQueue();
});

test("operator account provisioning (account_provisioning_requests): screen name + password login, hash only", async () => {
  const { startDeletionQueue, processProvisioningRequests, stopDeletionQueue } = await import("../../server/deletionQueue");
  const { hashPassword } = await import("../../server/authx/password");
  process.env.AUTH_EMAIL_DEV = "1"; // password sign-in needs the email provider on (prod: Gmail API configured)
  const pw = randomBytes(18).toString("base64url");
  const handle = `appreview_${uniq()}`;
  startDeletionQueue(60 * 60_000);
  await new Promise((r) => setTimeout(r, 200));
  await sql("INSERT INTO account_provisioning_requests (username, first_name, last_name, bio, password_hash, purpose, requested_by) VALUES ($1, 'App', 'Review', 'Demo account for App Review', $2, 'app review', 'test'), ('bad_hash_x', 'X', '', '', 'plaintext', 'x', 'test')", [handle, await hashPassword(pw)], DB());
  await processProvisioningRequests();
  const rows = await sql<{ username: string; result: string; user_id: string | null }>("SELECT username, result, user_id FROM account_provisioning_requests ORDER BY id", [], DB());
  assert.match(rows[0].result, /^created/);
  assert.ok(rows[0].user_id);
  assert.match(rows[1].result, /scrypt hash/);
  const ok = await api(app.base, "/auth/email/login", { identifier: handle, password: pw });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await api(app.base, "/auth/email/login", { identifier: handle, password: "wrong-password-1" })).status, 401);
  // a second run doesn't duplicate
  assert.equal(await processProvisioningRequests(), 0);
  await stopDeletionQueue();
});
