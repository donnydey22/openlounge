// Store compliance follow-up: chats with deleted accounts (Telegram-style). Everything a deleted account sent is
// marked read for its recipients (pointer + readAt, badge events), unread totals exclude deleted accounts, the
// already-deleted backfill is idempotent, and the per-user inbox actions (pin / unpin / read / remove = "Delete chat
// for me": unpin + read + hide in one go) work on deleted-account threads and persist in dm_chat_state.
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
const login = async (name = "User") => {
  const l = await phoneLogin(app.wsUrl, phone(), { firstName: name, username: `${name.toLowerCase()}_${uniq()}` });
  open.push(l);
  return l;
};
const tok = (x: Login) => x.res.access as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function deleteAccount(x: Login) {
  const reauth = (await api(app.base, "/api/me/delete/verify", { method: "recent" }, { token: tok(x) })).data.reauth;
  const r = await api(app.base, "/api/me/delete", { confirm: "DELETE", reauth }, { token: tok(x) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
}
function collect(x: Login, names: string[]) {
  const got: { ev: string; data: any }[] = [];
  x.client.ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "evt" && names.includes(m.ev)) got.push(m);
  });
  return got;
}
const row = (list: { conversations: { peer: { id: string }; unread: number; pinnedAt?: number }[] }, id: string) => list.conversations.find((c) => c.peer.id === id);

before(async () => {
  await sql("CREATE DATABASE store_test", [], "postgresql://ua@127.0.0.1:55433/postgres").catch(() => {});
  await wipeDb(DB());
  app = await startApp();
  (await import("../../server/push")).initPush();
});
after(async () => {
  for (const x of open) x.client.close();
  await app?.close();
});

test("deleting an account clears its unread for every recipient; the thread stays (and stays pinned) with 0 unread", async () => {
  const { store } = await import("../../server/store");
  const a = await login("Gone");
  const b = await login("Stay");
  const aid = a.res.user.id as string, bid = b.res.user.id as string;
  for (const t of ["one", "two", "three"]) assert.equal((await a.client.req("dm:send", { to: bid, text: t })).ok, true);
  let list = await b.client.req("dm:list", {});
  assert.equal(row(list, aid)?.unread, 3);
  assert.equal(list.unread, 3);
  const pin = await b.client.req("dm:chat", { peerId: aid, action: "pin" });
  assert.equal(pin.ok, true);
  assert.equal(pin.pinned, true);

  const evs = collect(b, ["dm:unread", "dm:read-receipt"]);
  await deleteAccount(a);
  for (let i = 0; i < 40 && !evs.some((e) => e.ev === "dm:unread"); i++) await sleep(50);
  assert.equal(evs.find((e) => e.ev === "dm:unread")?.data.count, 0, "B's tab badge gets the new total");

  list = await b.client.req("dm:list", {});
  const r = row(list, aid);
  assert.ok(r, "the thread is kept");
  assert.equal(r!.unread, 0);
  assert.ok(r!.pinnedAt, "still pinned until B unpins it");
  assert.equal(list.unread, 0);
  assert.equal(store.unreadDmCount(bid), 0, "push/app badge source");
  const hist = await b.client.req("dm:history", { peerId: aid });
  assert.equal(hist.messages.length, 3);
  for (const m of hist.messages) assert.ok(m.readAt, "every message from the deleted account is marked read");
  await store.flush();
  const [ptr] = await sql<{ last_read_at: string }>("SELECT last_read_at::text FROM dm_reads WHERE user_id = $1 AND peer_id = $2", [bid, aid], DB());
  assert.ok(Number(ptr.last_read_at) >= hist.messages[2].createdAt, "B's read pointer covers the last message");

  // inbox actions still work on a deleted-account thread
  const unpin = await b.client.req("dm:chat", { peerId: aid, action: "unpin" });
  assert.equal(unpin.ok, true);
  assert.equal(unpin.pinned, false);
  assert.equal(row(await b.client.req("dm:list", {}), aid)?.pinnedAt, undefined);
  await b.client.req("dm:chat", { peerId: aid, action: "pin" });

  const state = collect(b, ["dm:chat-state"]);
  const rm = await b.client.req("dm:chat", { peerId: aid, action: "remove" });
  assert.equal(rm.ok, true);
  assert.equal(rm.hidden, true);
  assert.equal(rm.pinned, false, "remove unpins");
  assert.equal(rm.unread, 0);
  for (let i = 0; i < 40 && !state.length; i++) await sleep(25);
  assert.deepEqual(state[0]?.data, { peerId: aid, pinned: false, hidden: true }, "B's other devices drop the row");
  assert.equal(row(await b.client.req("dm:list", {}), aid), undefined, "gone from B's inbox");
  assert.equal((await b.client.req("dm:history", { peerId: aid })).messages.length, 0, "messages hidden for B");
  assert.ok(!(await b.client.req("dm:since", { after: 0 })).messages.some((m: { fromId: string }) => m.fromId === aid), "reconnect catch-up hides them too");
  await store.chatPrefs.drain();
  const [st] = await sql<{ pinned_at: string | null; hidden_at: string | null }>("SELECT pinned_at, hidden_at FROM dm_chat_state WHERE user_id = $1 AND peer_id = $2", [bid, aid], DB());
  assert.equal(st.pinned_at, null);
  assert.ok(st.hidden_at);

  // survives a restart (fresh ChatPrefs loads from Postgres)
  const { ChatPrefs } = await import("../../server/chatPrefs");
  const reloaded = new ChatPrefs();
  await reloaded.load();
  assert.ok(reloaded.hiddenAt(bid, aid) > 0);
});

test("backfill: an account deleted before the fix (read pointer dropped) is cleared once, idempotently", async () => {
  const { store } = await import("../../server/store");
  const a = await login("Old");
  const b = await login("Inbox");
  const aid = a.res.user.id as string, bid = b.res.user.id as string;
  for (const t of ["x", "y"]) await a.client.req("dm:send", { to: bid, text: t });
  await deleteAccount(a);
  // simulate the old behaviour: B's pointer for A dropped, messages unstamped
  store.dmReads.get(bid)?.delete(aid);
  for (const m of (await b.client.req("dm:history", { peerId: aid })).messages) {
    const live = [...store.dms.values()].flat().find((x) => x.id === m.id);
    if (live) live.readAt = null;
  }
  assert.equal(store.unreadDmCount(bid), 0, "deleted accounts are excluded from totals even before the backfill");
  assert.deepEqual(store.readAllFrom(aid, { silent: true }), [bid]);
  assert.deepEqual(store.readAllFrom(aid, { silent: true }), [], "idempotent");
  for (const m of (await b.client.req("dm:history", { peerId: aid })).messages) assert.ok(m.readAt);
});

test("Delete chat for me on a live chat: hidden for me only; a newer message brings it back with just that message", async () => {
  const c = await login("Cee");
  const d = await login("Dee");
  const cid = c.res.user.id as string, did = d.res.user.id as string;
  await c.client.req("dm:send", { to: did, text: "old news" });
  const rm = await d.client.req("dm:chat", { peerId: cid, action: "remove" });
  assert.equal(rm.ok, true);
  assert.equal(row(await d.client.req("dm:list", {}), cid), undefined);
  assert.equal((await c.client.req("dm:history", { peerId: did })).messages.length, 1, "the other person keeps their copy");
  await sleep(5);
  await c.client.req("dm:send", { to: did, text: "fresh" });
  const back = row(await d.client.req("dm:list", {}), cid);
  assert.equal(back?.unread, 1);
  const h = await d.client.req("dm:history", { peerId: cid });
  assert.deepEqual(h.messages.map((m: { text: string }) => m.text), ["fresh"]);
  // bad input
  assert.equal((await d.client.req("dm:chat", { peerId: cid, action: "nuke" })).ok, false);
  assert.equal((await d.client.req("dm:chat", { peerId: did, action: "pin" })).ok, false);
  assert.equal((await d.client.req("dm:chat", { peerId: "u_nope", action: "pin" })).ok, false);
});
