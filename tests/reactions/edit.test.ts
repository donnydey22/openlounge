// Message editing (031): author-only, message_edited to both sides / all group members, edited_at + edit_count persisted,
// search triggers re-index the new text, PATCH twin, refusals (stickers, others' messages, empty, unchanged, rate limit).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import "./env";
import { setTestEnv, startApp, wipeDb, phoneLogin, sql, api, type App } from "../unified-auth/harness";
import { stickerText } from "../../src/lib/stickers/token";

setTestEnv({ providers: false });
let app: App;
type L = Awaited<ReturnType<typeof phoneLogin>>;
let A: L, B: L, C: L, D: L;
const uniq = () => randomBytes(3).toString("hex");
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const id = (x: L) => x.res.user.id as string;
function inbox(x: L) {
  const got: any[] = [];
  x.client.ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "evt" && m.ev === "message_edited") got.push(m.data);
  });
  return got;
}
let inA: any[], inB: any[], inC: any[], inD: any[];
const reset = () => [inA, inB, inC, inD].forEach((l) => (l.length = 0));
const send = async (from: L, to: string, text: string) => {
  const r = await from.client.req("dm:send", { to, text });
  assert.ok(r.ok, JSON.stringify(r));
  return r.message.id as string;
};
const waitFor = async (q: () => Promise<boolean>, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await q()) return true;
    await sleep(100);
  }
  return false;
};

before(async () => {
  await wipeDb();
  app = await startApp();
  A = await phoneLogin(app.wsUrl, phone(), { firstName: "Alice", username: `alice_${uniq()}` });
  B = await phoneLogin(app.wsUrl, phone(), { firstName: "Bob", username: `bob_${uniq()}` });
  C = await phoneLogin(app.wsUrl, phone(), { firstName: "Cara", username: `cara_${uniq()}` });
  D = await phoneLogin(app.wsUrl, phone(), { firstName: "Dan", username: `dan_${uniq()}` });
  inA = inbox(A); inB = inbox(B); inC = inbox(C); inD = inbox(D);
});
after(async () => {
  for (const x of [A, B, C, D]) x?.client.close();
  await app?.close();
});

test("1:1 edit: author only, both sides get message_edited keyed by the other person, persisted + re-indexed", async () => {
  const m = await send(A, id(B), "meet at #cafe tomrrow");
  reset();
  const r = await A.client.req("dm:edit", { chatId: id(B), messageId: m, text: "meet at #library tomorrow" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.message.text, "meet at #library tomorrow");
  assert.equal(r.message.editCount, 1);
  assert.ok(r.message.editedAt > 0);
  await sleep(200);
  assert.equal(inB.length, 1);
  assert.equal(inB[0].conversationId, id(A));
  assert.equal(inB[0].messageId, m);
  assert.equal(inB[0].text, "meet at #library tomorrow");
  assert.equal(inA[0].conversationId, id(B), "my other tabs keyed by the peer");
  assert.equal(inC.length, 0, "outsiders hear nothing");
  // history carries the stamps
  const h = await B.client.req("dm:history", { peerId: id(A) });
  const row = h.messages.find((x: any) => x.id === m);
  assert.equal(row.text, "meet at #library tomorrow");
  assert.equal(row.editCount, 1);
  // Postgres: the text + 020 triggers (hashtags) + 031 stamp
  assert.ok(await waitFor(async () => (await sql<{ text: string }>("SELECT text FROM dms WHERE id = $1", [m]))[0]?.text === "meet at #library tomorrow"), "dms.text updated");
  assert.ok(await waitFor(async () => (await sql("SELECT 1 FROM dm_edits WHERE message_id = $1 AND edit_count = 1", [m])).length === 1), "dm_edits row");
  const tags = await sql<{ tag: string }>("SELECT * FROM message_hashtags WHERE message_id = $1", [m]).catch(() => null);
  if (tags) {
    const all = JSON.stringify(tags);
    assert.ok(all.includes("library") && !all.includes("cafe"), "hashtag index follows the edit: " + all);
  }
  // second edit bumps the count
  const r2 = await A.client.req("dm:edit", { chatId: id(B), messageId: m, text: "meet at #library at 5" });
  assert.equal(r2.message.editCount, 2);
});

test("refusals: someone else's message, stickers, empty, unchanged (no event), wrong chat", async () => {
  const theirs = await send(B, id(A), "hello");
  const nope = await A.client.req("dm:edit", { chatId: id(B), messageId: theirs, text: "hacked" });
  assert.equal(nope.ok, false);
  assert.match(nope.error, /own messages/);
  const stk = await send(A, id(B), stickerText({ packId: "classic", stickerId: "wave", emoji: "👋" }));
  const s = await A.client.req("dm:edit", { chatId: id(B), messageId: stk, text: "not a sticker" });
  assert.equal(s.ok, false);
  assert.match(s.error, /can't be edited/);
  const mine = await send(A, id(B), "same");
  const empty = await A.client.req("dm:edit", { chatId: id(B), messageId: mine, text: "   " });
  assert.equal(empty.ok, false);
  reset();
  const same = await A.client.req("dm:edit", { chatId: id(B), messageId: mine, text: "same" });
  assert.equal(same.ok, true);
  assert.equal(same.unchanged, true);
  const wrong = await C.client.req("dm:edit", { chatId: id(B), messageId: mine, text: "x" });
  assert.equal(wrong.ok, false);
  await sleep(150);
  assert.equal(inB.length + inA.length, 0, "no event for refused / unchanged edits");
});

test("PATCH /api/messages/:id is the same edit (auth required)", async () => {
  const m = await send(A, id(B), "typo teh");
  const anon = await api(app.base, `/api/messages/${m}`, { chat: id(B), text: "x" }, { method: "PATCH" });
  assert.equal(anon.status, 401);
  reset();
  const r = await api(app.base, `/api/messages/${m}`, { chat: id(B), text: "typo the" }, { method: "PATCH", token: A.res.access });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.message.text, "typo the");
  await sleep(200);
  assert.equal(inB[0]?.text, "typo the");
  const bad = await api(app.base, `/api/messages/${m}`, { chat: id(A), text: "mine now" }, { method: "PATCH", token: B.res.access });
  assert.equal(bad.status, 403);
});

test("groups: members get message_edited with the group id; non-members can't edit", async () => {
  const g = await A.client.req("group:create", { title: "Edit crew", memberIds: [id(B), id(C)] });
  assert.equal(g.ok, true, JSON.stringify(g));
  const gid = g.group.id as string;
  const m = await send(A, gid, "hi all, meting at 5");
  reset();
  const r = await A.client.req("dm:edit", { chatId: gid, messageId: m, text: "hi all, meeting at 5" });
  assert.equal(r.ok, true, JSON.stringify(r));
  await sleep(200);
  for (const l of [inA, inB, inC]) assert.ok(l.some((e) => e.conversationId === gid && e.messageId === m && e.text === "hi all, meeting at 5"));
  assert.equal(inD.length, 0);
  const outsider = await D.client.req("dm:edit", { chatId: gid, messageId: m, text: "x" });
  assert.equal(outsider.ok, false);
  const member = await B.client.req("dm:edit", { chatId: gid, messageId: m, text: "x" });
  assert.equal(member.ok, false, "members can't edit someone else's message (admins neither)");
});

test("rate limit: 20 edits a minute", async () => {
  const m = await send(C, id(D), "v0");
  let last: any = null;
  for (let i = 1; i <= 21; i++) last = await C.client.req("dm:edit", { chatId: id(D), messageId: m, text: "v" + i });
  assert.equal(last.ok, false);
  assert.match(last.error, /Slow down/);
});
