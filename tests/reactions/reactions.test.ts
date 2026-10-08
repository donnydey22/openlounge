// DM emoji reactions + emoji interactions: real WebSocket clients against the app server (local Postgres only).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import "./env";
import { setTestEnv, startApp, wipeDb, api, phoneLogin, sql, type App } from "../unified-auth/harness";

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
    if (m.t === "evt" && /^dm:(reaction|emoji_interaction)/.test(String(m.ev))) got.push({ ev: m.ev, data: m.data });
  });
  return got;
}
const emit = (x: L, ev: string, data: unknown) => x.client.ws.send(JSON.stringify({ t: "evt", ev, data }));
let inA: ReturnType<typeof inbox>, inB: ReturnType<typeof inbox>, inC: ReturnType<typeof inbox>;
const reset = () => { inA.length = 0; inB.length = 0; inC.length = 0; };
let msgId = "";

before(async () => {
  await wipeDb();
  app = await startApp();
  A = await phoneLogin(app.wsUrl, phone(), { firstName: "Alice", username: `alice_${uniq()}` });
  B = await phoneLogin(app.wsUrl, phone(), { firstName: "Bob", username: `bob_${uniq()}` });
  C = await phoneLogin(app.wsUrl, phone(), { firstName: "Cara", username: `cara_${uniq()}` });
  inA = inbox(A); inB = inbox(B); inC = inbox(C);
  const r = await A.client.req("dm:send", { to: id(B), text: "react to me" });
  assert.ok(r.ok);
  msgId = r.message.id;
});
after(async () => {
  for (const x of [A, B, C]) x?.client.close();
  await app?.close();
});

test("add → broadcast to both participants only, stored on the message", async () => {
  reset();
  const r = await B.client.req("dm:reaction_add", { peerId: id(A), messageId: msgId, emoji: "🔥" });
  assert.equal(r.ok, true, JSON.stringify(r));
  await sleep(200);
  assert.deepEqual(inA.map((e) => e.ev), ["dm:reaction_add"]);
  assert.deepEqual(inB.map((e) => e.ev), ["dm:reaction_add"], "reactor's own tabs stay in sync");
  assert.equal(inA[0].data.emoji, "🔥");
  assert.equal(inA[0].data.userId, id(B));
  assert.equal(inA[0].data.messageId, msgId);
  assert.equal(inC.length, 0, "third party sees nothing");
  const h = await A.client.req("dm:history", { peerId: id(B) });
  assert.deepEqual(h.messages[0].reactions.map((x: any) => [x.emoji, x.userId]), [["🔥", id(B)]]);
});

test("one reaction per person: picking another replaces it (remove + add)", async () => {
  reset();
  const r = await B.client.req("dm:reaction_add", { peerId: id(A), messageId: msgId, emoji: "❤️" });
  assert.equal(r.ok, true);
  await sleep(200);
  assert.deepEqual(inA.map((e) => `${e.ev}:${e.data.emoji}`), ["dm:reaction_remove:🔥", "dm:reaction_add:❤️"]);
  assert.deepEqual(r.reactions.map((x: any) => x.emoji), ["❤️"]);
});

test("text-presentation heart and emoji heart are the same reaction; duplicate add is a no-op", async () => {
  reset();
  const r = await B.client.req("dm:reaction_add", { peerId: id(A), messageId: msgId, emoji: "❤" });
  assert.equal(r.ok, true);
  assert.equal(r.added, null);
  await sleep(150);
  assert.equal(inA.length, 0);
});

test("both people react; remove only removes mine", async () => {
  await A.client.req("dm:reaction_add", { peerId: id(B), messageId: msgId, emoji: "❤️" });
  await sleep(150);
  reset();
  const r = await A.client.req("dm:reaction_remove", { peerId: id(B), messageId: msgId, emoji: "❤️" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.reactions.map((x: any) => x.userId), [id(B)]);
  await sleep(150);
  assert.deepEqual(inB.map((e) => e.ev), ["dm:reaction_remove"]);
});

test("validation: non-participant, unknown message, not-an-emoji, text are refused", async () => {
  const outsider = await C.client.req("dm:reaction_add", { peerId: id(A), messageId: msgId, emoji: "👍" });
  assert.equal(outsider.ok, false);
  const unknown = await A.client.req("dm:reaction_add", { peerId: id(B), messageId: "nope-123", emoji: "👍" });
  assert.equal(unknown.ok, false);
  for (const bad of ["a", "hello", "👍👍", "<script>", ""]) {
    const r = await A.client.req("dm:reaction_add", { peerId: id(B), messageId: msgId, emoji: bad });
    assert.equal(r.ok, false, `refused ${JSON.stringify(bad)}`);
  }
  for (const good of ["👍🏽", "🏳️‍🌈", "🇺🇸", "❤️‍🔥"]) {
    const r = await A.client.req("dm:reaction_add", { peerId: id(B), messageId: msgId, emoji: good });
    assert.equal(r.ok, true, `accepted ${good}: ${JSON.stringify(r)}`);
  }
});

test("persisted in dm_reactions and survives a reload", async () => {
  await sleep(1200); // debounced save
  const rows = await sql<{ emoji: string; user_id: string }>("SELECT emoji, user_id FROM dm_reactions WHERE message_id = $1 ORDER BY created_at", [msgId]);
  assert.deepEqual(rows.map((r) => r.emoji).sort(), ["❤️", "❤️‍🔥"].sort());
  const { store } = await import("../../server/store");
  const persisted = (await (store as any).backend.load()).db.dms.find((m: any) => m.id === msgId);
  assert.equal(persisted.reactions.length, 2);
});

test("blocked either way → reactions refused and nothing relayed", async () => {
  const r = await api(app.base, "/api/me/blocks", { userId: id(A), block: true }, { token: B.res.access });
  assert.equal(r.status, 200);
  reset();
  const x = await A.client.req("dm:reaction_add", { peerId: id(B), messageId: msgId, emoji: "😂" });
  const y = await B.client.req("dm:reaction_add", { peerId: id(A), messageId: msgId, emoji: "😂" });
  assert.equal(x.ok, false);
  assert.equal(y.ok, false);
  emit(A, "dm:emoji_interaction", { to: id(B), messageId: msgId, emoji: "🎉" });
  await sleep(250);
  assert.equal(inA.length + inB.length, 0);
  await api(app.base, "/api/me/blocks", { userId: id(A), block: false }, { token: B.res.access });
});

test("emoji interaction: relayed to the peer only, ephemeral, throttled", async () => {
  reset();
  for (let i = 0; i < 6; i++) emit(A, "dm:emoji_interaction", { to: id(B), messageId: msgId, emoji: "🎉" });
  emit(A, "dm:emoji_interaction", { to: id(B), messageId: msgId, emoji: "nope" });
  await sleep(300);
  assert.equal(inB.length, 1, "burst collapses to one");
  assert.deepEqual(inB[0].data, { from: id(A), messageId: msgId, emoji: "🎉" });
  assert.equal(inA.length + inC.length, 0);
});

test("rate limit: 40 reaction changes / 10 s per user", async () => {
  const emojis = ["😀", "😃"];
  let refused = 0;
  for (let i = 0; i < 45; i++) {
    const r = await A.client.req("dm:reaction_add", { peerId: id(B), messageId: msgId, emoji: emojis[i % 2] });
    if (!r.ok) refused++;
  }
  assert.ok(refused >= 1, `some refused (${refused})`);
});
