// Telegram-style delete in 1:1 chats (030): for me vs for everyone, ownership, broadcast, archive, history/inbox.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import "./env";
import { setTestEnv, startApp, wipeDb, phoneLogin, sql, type App } from "../unified-auth/harness";

setTestEnv({ providers: false });
let app: App;
type L = Awaited<ReturnType<typeof phoneLogin>>;
let A: L, B: L, C: L;
const uniq = () => randomBytes(3).toString("hex");
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const id = (x: L) => x.res.user.id as string;
function inbox(x: L) {
  const got: { ev: string; data: any }[] = [];
  x.client.ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "evt" && (m.ev === "conv:deleted" || m.ev === "dm:unread")) got.push({ ev: m.ev, data: m.data });
  });
  return got;
}
let inA: ReturnType<typeof inbox>, inB: ReturnType<typeof inbox>, inC: ReturnType<typeof inbox>;
const reset = () => { inA.length = 0; inB.length = 0; inC.length = 0; };
const send = async (from: L, to: L, text: string) => {
  const r = await from.client.req("dm:send", { to: id(to), text });
  assert.ok(r.ok, JSON.stringify(r));
  return r.message.id as string;
};
const ids = async (x: L, peer: L) => ((await x.client.req("dm:history", { peerId: id(peer) })).messages as { id: string }[]).map((m) => m.id);

before(async () => {
  await wipeDb();
  app = await startApp();
  A = await phoneLogin(app.wsUrl, phone(), { firstName: "Alice", username: `alice_${uniq()}` });
  B = await phoneLogin(app.wsUrl, phone(), { firstName: "Bob", username: `bob_${uniq()}` });
  C = await phoneLogin(app.wsUrl, phone(), { firstName: "Cara", username: `cara_${uniq()}` });
  inA = inbox(A); inB = inbox(B); inC = inbox(C);
});
after(async () => {
  for (const x of [A, B, C]) x?.client.close();
  await app?.close();
});

test("delete for everyone: content leaves both sides (placeholder remains), peer + my tabs get conv:deleted, archived", async () => {
  const m1 = await send(A, B, "oops wrong chat");
  const m2 = await send(A, B, "this one too");
  const keep = await send(B, A, "hi");
  reset();
  const r = await A.client.req("dm:delete", { peerId: id(B), messageIds: [m1, m2], forEveryone: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([...r.messageIds].sort(), [m1, m2].sort());
  await sleep(250);
  const del = (l: typeof inA) => l.filter((e) => e.ev === "conv:deleted");
  assert.deepEqual(del(inB).map((e) => e.data.messageId).sort(), [m1, m2].sort());
  assert.ok(del(inB).every((e) => e.data.conversationId === id(A) && e.data.forEveryone === true), "peer sees it keyed by MY id");
  assert.ok(del(inA).every((e) => e.data.conversationId === id(B)), "my other tabs keyed by the peer");
  assert.equal(del(inC).length, 0);
  assert.ok(inB.some((e) => e.ev === "dm:unread"), "peer unread badge refreshed " + JSON.stringify(inB.map((e) => e.ev)) + JSON.stringify(r));
  // content leaves both sides; each side sees a "This message was deleted" placeholder in its place
  for (const [x, y] of [[A, B], [B, A]] as const) {
    const h = await x.client.req("dm:history", { peerId: id(y) });
    const mine = h.messages.filter((m: any) => [m1, m2, keep].includes(m.id));
    assert.deepEqual(mine.filter((m: any) => !m.deleted).map((m: any) => m.id), [keep]);
    assert.ok(mine.filter((m: any) => m.deleted).every((m: any) => m.text === "This message was deleted" && !m.media), "placeholder only");
    assert.equal(mine.filter((m: any) => m.deleted).length, 2);
  }
  assert.ok(del(inB).every((e) => e.data.placeholder?.deleted === true), "peer gets the placeholder live");
  await sleep(1200);
  const rows = await sql<{ message_id: string; deleted_by: string; text: string }>("SELECT message_id, deleted_by, text FROM dm_deleted WHERE message_id = ANY($1)", [[m1, m2]]);
  assert.equal(rows.length, 2, "soft delete: archived for moderation");
  assert.ok(rows.every((x) => x.deleted_by === id(A)));
  const live = await sql("SELECT id FROM dms WHERE id = ANY($1)", [[m1, m2]]);
  assert.equal(live.length, 0, "gone from the live table (search triggers / indexes forget it)");
});

test("for everyone is author-only; for me hides any message on my side only", async () => {
  const theirs = await send(B, A, "Bob's message");
  const bad = await A.client.req("dm:delete", { peerId: id(B), messageIds: [theirs], forEveryone: true });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /own messages/);
  reset();
  const r = await A.client.req("dm:delete", { peerId: id(B), messageIds: [theirs] });
  assert.equal(r.ok, true, JSON.stringify(r));
  await sleep(200);
  assert.equal(inB.filter((e) => e.ev === "conv:deleted").length, 0, "peer is not told");
  assert.equal(inA.filter((e) => e.ev === "conv:deleted").length, 1, "my other devices drop it too");
  assert.ok(!(await ids(A, B)).includes(theirs));
  assert.ok((await ids(B, A)).includes(theirs), "still there for Bob");
  // inbox preview skips it for me
  const conv = await A.client.req("dm:list", {});
  const row = (conv.conversations as any[]).find((c) => c.peer.id === id(B));
  assert.notEqual(row?.lastMessage?.id, theirs);
  // reconnect catch-up skips it for me
  const since = await A.client.req("dm:since", { after: 0 });
  assert.ok(!(since.messages as any[]).some((m) => m.id === theirs));
  await sleep(1000);
  const h = await sql("SELECT 1 FROM dm_hidden WHERE user_id = $1 AND message_id = $2", [id(A), theirs]);
  assert.equal(h.length, 1, "persisted");
});

test("validation: no third parties, no groups, sane batch sizes, unknown ids are a no-op", async () => {
  const m = await send(A, B, "private");
  const r1 = await C.client.req("dm:delete", { peerId: id(A), messageIds: [m], forEveryone: true });
  assert.equal(r1.ok, true, "C has no such message in C↔A → nothing happens");
  assert.deepEqual(r1.messageIds, []);
  assert.ok((await ids(B, A)).includes(m));
  assert.equal((await A.client.req("dm:delete", { peerId: id(B), messageIds: [] })).ok, false);
  assert.equal((await A.client.req("dm:delete", { peerId: id(B), messageIds: Array.from({ length: 101 }, (_, i) => `x${i}`) })).ok, false);
  assert.equal((await A.client.req("dm:delete", { peerId: "g_abc", messageIds: [m] })).ok, false);
  const again = await A.client.req("dm:delete", { peerId: id(B), messageIds: ["nope"], forEveryone: true });
  assert.equal(again.ok, true);
  assert.deepEqual(again.messageIds, []);
});
