// UGC safety integration: block enforcement (DMs, suggestions, follows, persistence) and the report API
// (validation, auth, rate limit, admin listing). Local Postgres only (TEST_DATABASE_URL; the schema is wiped).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import "./env";
import { setTestEnv, startApp, wipeDb, api, phoneLogin, sql, type App } from "../unified-auth/harness";

setTestEnv({ providers: false });
let app: App;
const uniq = () => randomBytes(3).toString("hex");
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;

let A: Awaited<ReturnType<typeof phoneLogin>>, B: Awaited<ReturnType<typeof phoneLogin>>, C: Awaited<ReturnType<typeof phoneLogin>>;
let aid: string, bid: string, cid: string;

before(async () => {
  await wipeDb();
  app = await startApp();
  A = await phoneLogin(app.wsUrl, phone(), { firstName: "Alice", username: `alice_${uniq()}` });
  B = await phoneLogin(app.wsUrl, phone(), { firstName: "Bob", username: `bob_${uniq()}` });
  C = await phoneLogin(app.wsUrl, phone(), { firstName: "Cara", username: `cara_${uniq()}` });
  aid = A.res.user.id;
  bid = B.res.user.id;
  cid = C.res.user.id;
});
after(async () => {
  for (const x of [A, B, C]) x?.client.close();
  await app?.close();
});

const tok = (x: typeof A) => x.res.access as string;

test("block: blocked users can't DM you, and you can't DM them", async () => {
  assert.equal((await B.client.req("dm:send", { to: aid, text: "hi alice" })).ok, true);
  assert.equal((await B.client.req("user:follow", { userId: aid, follow: true })).ok, true);

  const r = await api(app.base, "/api/me/blocks", { userId: bid, block: true }, { token: tok(A) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.blocked.map((u: { id: string }) => u.id), [bid]);

  const fromB = await B.client.req("dm:send", { to: aid, text: "are you there?" });
  assert.equal(fromB.ok, false);
  const fromA = await A.client.req("dm:send", { to: bid, text: "hi" });
  assert.equal(fromA.ok, false);

  // A's inbox and the thread hide B; B also loses the thread
  const list = await A.client.req("dm:list");
  assert.ok(!list.conversations.some((c: { peer: { id: string } }) => c.peer.id === bid));
  const hist = await A.client.req("dm:history", { peerId: bid });
  assert.equal(hist.messages.length, 0);
  const listB = await B.client.req("dm:list");
  assert.ok(!listB.conversations.some((c: { peer: { id: string } }) => c.peer.id === aid));

  // follows removed both ways and can't be re-created
  const { store } = await import("../../server/store");
  assert.equal(store.followingIds(bid).includes(aid), false);
  assert.equal((await B.client.req("user:follow", { userId: aid, follow: true })).ok, false);

  // B doesn't see A in follow suggestions (and vice versa); C still sees both
  const sugB = await B.client.req("onboarding:suggestions");
  assert.ok(!sugB.users.some((u: { id: string }) => u.id === aid));
  const sugA = await A.client.req("onboarding:suggestions");
  assert.ok(!sugA.users.some((u: { id: string }) => u.id === bid));
  const sugC = await C.client.req("onboarding:suggestions");
  assert.ok(sugC.users.some((u: { id: string }) => u.id === aid) && sugC.users.some((u: { id: string }) => u.id === bid));

  // hidden ids: B learns it must hide A's content (room chat filtering is client-side)
  const hb = await api(app.base, "/api/me/blocks", undefined, { token: tok(B), method: "GET" });
  assert.deepEqual(hb.data.hidden, [aid]);
  assert.deepEqual(hb.data.blocked, []);

  // persisted in user_blocks
  await store.flush();
  const rows = await sql("SELECT blocker_id, blocked_id FROM user_blocks");
  assert.deepEqual(rows, [{ blocker_id: aid, blocked_id: bid }]);
});

test("unblock restores DMs; can't block yourself; auth required", async () => {
  const r = await api(app.base, "/api/me/blocks", { userId: bid, block: false }, { token: tok(A) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.blocked, []);
  assert.equal((await B.client.req("dm:send", { to: aid, text: "back again" })).ok, true);
  const list = await A.client.req("dm:list");
  assert.ok(list.conversations.some((c: { peer: { id: string } }) => c.peer.id === bid));
  assert.equal((await api(app.base, "/api/me/blocks", { userId: aid, block: true }, { token: tok(A) })).status, 400);
  assert.equal((await api(app.base, "/api/me/blocks", { userId: bid, block: true })).status, 401);
  assert.equal((await api(app.base, "/api/me/blocks", { userId: "u_nope", block: true }, { token: tok(A) })).status, 404);
  const { store } = await import("../../server/store");
  await store.flush();
  assert.equal((await sql("SELECT * FROM user_blocks")).length, 0);
});

test("report API: user / room / message / dm, validation, dedupe, persistence", async () => {
  // user
  const u = await api(app.base, "/api/reports", { targetType: "user", targetId: bid, reason: "harassment", note: "keeps messaging me" }, { token: tok(A) });
  assert.equal(u.status, 201, JSON.stringify(u.data));
  // same open report again → deduped
  const again = await api(app.base, "/api/reports", { targetType: "user", targetId: bid, reason: "harassment" }, { token: tok(A) });
  assert.equal(again.status, 201);
  assert.equal(again.data.duplicate, true);
  assert.equal(again.data.id, u.data.id);

  // room + room chat message
  const room = await B.client.req("room:create", { title: "Bob's room" });
  assert.equal(room.ok, true);
  assert.equal((await B.client.req("room:join", { roomId: room.roomId })).ok, true);
  const msg = await B.client.req("chat:send", { roomId: room.roomId, text: "hello room" });
  assert.equal(msg.ok, true);
  assert.equal((await api(app.base, "/api/reports", { targetType: "room", targetId: room.roomId, reason: "spam" }, { token: tok(A) })).status, 201);
  const mr = await api(app.base, "/api/reports", { targetType: "message", targetId: msg.message.id, roomId: room.roomId, reason: "hate" }, { token: tok(A) });
  assert.equal(mr.status, 201, JSON.stringify(mr.data));

  // dm: only participants may report
  const dm = await B.client.req("dm:send", { to: aid, text: "a dm to report" });
  assert.equal((await api(app.base, "/api/reports", { targetType: "dm", targetId: dm.message.id, reason: "sexual" }, { token: tok(C) })).status, 404);
  assert.equal((await api(app.base, "/api/reports", { targetType: "dm", targetId: dm.message.id, reason: "sexual" }, { token: tok(A) })).status, 201);

  // validation + auth
  assert.equal((await api(app.base, "/api/reports", { targetType: "user", targetId: bid, reason: "nope" }, { token: tok(A) })).status, 400);
  assert.equal((await api(app.base, "/api/reports", { targetType: "planet", targetId: bid, reason: "spam" }, { token: tok(A) })).status, 400);
  assert.equal((await api(app.base, "/api/reports", { targetType: "user", targetId: aid, reason: "spam" }, { token: tok(A) })).status, 400);
  assert.equal((await api(app.base, "/api/reports", { targetType: "user", targetId: bid, reason: "spam" })).status, 401);

  const { store } = await import("../../server/store");
  await store.flush();
  const rows = await sql<{ target_type: string; target_user_id: string; snapshot: string; note: string }>("SELECT target_type, target_user_id, snapshot, note FROM content_reports ORDER BY created_at");
  assert.deepEqual(rows.map((r) => r.target_type), ["user", "room", "message", "dm"]);
  assert.ok(rows.every((r) => r.target_user_id === bid));
  assert.equal(rows[2].snapshot, "hello room");
  assert.equal(rows[0].note, "keeps messaging me");
});

test("report API is rate limited (5 / minute)", async () => {
  // C files reports against distinct DMs from B
  const { store } = await import("../../server/store");
  // seed messages directly (the DM send limit is 8 / 10 s)
  const ids = Array.from({ length: 7 }, (_, i) => (store as unknown as { appendDm(f: string, t: string, x: string): { id: string } }).appendDm(bid, cid, `spam ${i}`).id);
  const statuses: number[] = [];
  for (const id of ids) statuses.push((await api(app.base, "/api/reports", { targetType: "dm", targetId: id, reason: "spam" }, { token: tok(C) })).status);
  assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429, 429]);
});

test("admin endpoint: ADMIN_USER_IDS only", async () => {
  process.env.ADMIN_USER_IDS = `u_someone_else, ${cid}`;
  assert.equal((await api(app.base, "/api/admin/reports", undefined, { token: tok(A), method: "GET" })).status, 403);
  assert.equal((await api(app.base, "/api/admin/reports", undefined, { method: "GET" })).status, 401);
  const r = await api(app.base, "/api/admin/reports", undefined, { token: tok(C), method: "GET" });
  assert.equal(r.status, 200);
  assert.ok(r.data.reports.length >= 9, String(r.data.reports.length));
  assert.equal(r.data.reports[r.data.reports.length - 1].reporter.id, aid);
  const id = r.data.reports[0].id;
  const s = await api(app.base, `/api/admin/reports/${id}`, { status: "dismissed" }, { token: tok(C) });
  assert.equal(s.status, 200);
  assert.equal(s.data.report.status, "dismissed");
});

test("content filter applies to chat, DMs, bios and room titles", async () => {
  const masked = await A.client.req("dm:send", { to: bid, text: "well shit" });
  assert.equal(masked.ok, true);
  assert.equal(masked.message.text, "well s***");
  assert.equal((await A.client.req("dm:send", { to: bid, text: "you faggot" })).ok, false);
  assert.equal((await A.client.req("room:create", { title: "kike club" })).ok, false);
  const bio = await A.client.req("user:update", { bio: "retard" });
  assert.equal(bio.ok, false);
  const bio2 = await A.client.req("user:update", { bio: "I love this shit" });
  assert.equal(bio2.ok, true);
  assert.equal(bio2.user.bio, "I love this s***");
});
