// Store compliance: moderator enforcement (remove DM / room message, end room, suspend + unsuspend) and the
// public account-deletion API. Local Postgres only (separate throwaway DB; the schema is wiped).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import "./env";
import { setTestEnv, startApp, wipeDb, api, phoneLogin, sql, type App } from "../unified-auth/harness";

setTestEnv({ providers: false, dbUrl: process.env.TEST_DATABASE_URL });
let app: App;
const uniq = () => randomBytes(3).toString("hex");
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
let A: Awaited<ReturnType<typeof phoneLogin>>, B: Awaited<ReturnType<typeof phoneLogin>>, M: Awaited<ReturnType<typeof phoneLogin>>;
let aid: string, bid: string, mid: string;
const bPhone = phone();
const tok = (x: typeof A) => x.res.access as string;

before(async () => {
  await sql("CREATE DATABASE store_test", [], "postgresql://ua@127.0.0.1:55433/postgres").catch(() => {});
  await wipeDb(process.env.TEST_DATABASE_URL);
  app = await startApp();
  A = await phoneLogin(app.wsUrl, phone(), { firstName: "Alice", username: `alice_${uniq()}` });
  B = await phoneLogin(app.wsUrl, bPhone, { firstName: "Bob", username: `bob_${uniq()}` });
  M = await phoneLogin(app.wsUrl, phone(), { firstName: "Mod", username: `mod_${uniq()}` });
  aid = A.res.user.id;
  bid = B.res.user.id;
  mid = M.res.user.id;
  process.env.ADMIN_USER_IDS = mid;
});
after(async () => {
  for (const x of [A, B, M]) x?.client.close();
  await app?.close();
});

const report = async (body: Record<string, unknown>) => {
  const r = await api(app.base, "/api/reports", body, { token: tok(A) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id as string;
};
const act = (id: string, action: string, who = M) => api(app.base, `/api/admin/reports/${id}/action`, { action }, { token: tok(who) });

test("non-admins can't act; unknown actions rejected", async () => {
  const id = await report({ targetType: "user", targetId: bid, reason: "spam" });
  assert.equal((await act(id, "suspend_user", A)).status, 403);
  assert.equal((await act(id, "nuke")).status, 400);
  assert.equal((await act("rp_nope", "suspend_user")).status, 404);
});

test("remove a reported DM: gone from the thread and from Postgres", async () => {
  const dm = await B.client.req("dm:send", { to: aid, text: "a nasty dm" });
  const id = await report({ targetType: "dm", targetId: dm.message.id, reason: "harassment" });
  const r = await act(id, "remove_content");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.done, true);
  assert.equal(r.data.report.status, "actioned");
  const hist = await A.client.req("dm:history", { peerId: bid });
  assert.ok(!hist.messages.some((m: { id: string }) => m.id === dm.message.id));
  const rows = await sql("SELECT id FROM dms WHERE id = $1", [dm.message.id], process.env.TEST_DATABASE_URL);
  assert.equal(rows.length, 0);
  const audit = await sql<{ action: string }>("SELECT action FROM moderation_actions WHERE report_id = $1", [id], process.env.TEST_DATABASE_URL);
  assert.deepEqual(audit.map((x) => x.action), ["remove_content"]);
});

test("remove a room chat message, then end the room", async () => {
  const room = await B.client.req("room:create", { title: "Bob's room" });
  assert.equal((await B.client.req("room:join", { roomId: room.roomId })).ok, true);
  const msg = await B.client.req("chat:send", { roomId: room.roomId, text: "bad message" });
  const id = await report({ targetType: "message", targetId: msg.message.id, roomId: room.roomId, reason: "hate" });
  assert.equal((await act(id, "remove_content")).data.done, true);
  const { store } = await import("../../server/store");
  assert.ok(!store.rooms.get(room.roomId)!.chat.some((m) => m.id === msg.message.id));
  const e = await act(id, "end_room");
  assert.equal(e.data.done, true);
  assert.equal(store.rooms.get(room.roomId)?.ended ?? true, true);
});

test("suspend: tokens rejected everywhere, persisted; unsuspend restores", async () => {
  const id = await report({ targetType: "user", targetId: bid, reason: "harassment" });
  const s = await act(id, "suspend_user");
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.suspended, true);
  const blocked = await api(app.base, "/api/me/blocks", undefined, { token: tok(B), method: "GET" });
  assert.equal(blocked.status, 401);
  const rows = await sql("SELECT user_id FROM user_suspensions", [], process.env.TEST_DATABASE_URL);
  assert.deepEqual(rows, [{ user_id: bid }]);
  // signing in again mints a token, but the suspension gate rejects it
  const again = await phoneLogin(app.wsUrl, bPhone).catch(() => null);
  assert.ok(again?.res?.access, "re-login should mint a token");
  if (again?.res?.access) {
    assert.equal((await api(app.base, "/api/me/blocks", undefined, { token: again.res.access, method: "GET" })).status, 401);
    again.client.close();
  }
  const list = await api(app.base, "/api/admin/suspensions", undefined, { token: tok(M), method: "GET" });
  assert.equal(list.data.suspensions[0].userId, bid);
  // other users unaffected
  assert.equal((await api(app.base, "/api/me/blocks", undefined, { token: tok(A), method: "GET" })).status, 200);
  const u = await act(id, "unsuspend_user");
  assert.equal(u.data.suspended, false);
  assert.equal((await sql("SELECT user_id FROM user_suspensions", [], process.env.TEST_DATABASE_URL)).length, 0);
});

test("account deletion API (used by Settings and /privacy/delete-account)", async () => {
  assert.equal((await api(app.base, "/api/me/delete", { confirm: "nope" }, { token: tok(A) })).status, 400);
  assert.equal((await api(app.base, "/api/me/delete", { confirm: "DELETE" })).status, 401);
  assert.equal((await api(app.base, "/api/me/delete", { confirm: "DELETE" }, { token: tok(A) })).status, 403);
  const reauth = (await api(app.base, "/api/me/delete/verify", { method: "recent" }, { token: tok(A) })).data.reauth;
  const r = await api(app.base, "/api/me/delete", { confirm: "DELETE", reauth }, { token: tok(A) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rows = await sql<{ name: string; deleted_at: string | null }>("SELECT name, deleted_at FROM users WHERE id = $1", [aid], process.env.TEST_DATABASE_URL);
  assert.equal(rows[0]?.name, "Deleted Account");
  assert.ok(rows[0]?.deleted_at);
});
