// Audio rooms in DMs: live invite cards + private drop-in audio chats. Real WebSocket clients against the app server
// (local Postgres only).
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

type Ev = { ev: string; data: any; at: number };
function inbox(x: L) {
  const got: Ev[] = [];
  x.client.ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "evt") got.push({ ev: m.ev, data: m.data, at: Date.now() });
  });
  return got;
}
async function waitFor<T>(fn: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out waiting");
    await sleep(20);
  }
}
let inA: Ev[], inB: Ev[], inC: Ev[];
const lastCard = (box: Ev[], roomId: string) => [...box].reverse().find((e) => e.ev === "room:card" && e.data.roomId === roomId)?.data;

before(async () => {
  await wipeDb();
  app = await startApp();
  A = await phoneLogin(app.wsUrl, phone(), { firstName: "Donny", username: `donny_${uniq()}` });
  B = await phoneLogin(app.wsUrl, phone(), { firstName: "Bea", username: `bea_${uniq()}` });
  C = await phoneLogin(app.wsUrl, phone(), { firstName: "Cal", username: `cal_${uniq()}` });
  inA = inbox(A);
  inB = inbox(B);
  inC = inbox(C);
});
after(async () => {
  for (const x of [A, B, C]) x?.client.close();
  await app?.close();
});

let publicRoom = "";

test("invite card from inside a live room: rich DM to the recipient, push-free when foreground, live card state", async () => {
  const c = await A.client.req("room:create", { title: "Late night builders" });
  assert.ok(c.ok);
  publicRoom = c.roomId;
  const j = await A.client.req("room:join", { roomId: publicRoom });
  assert.ok(j.ok);
  // the LiveKit join token rides on the join ack (no extra HTTP round trip before audio connects)
  assert.equal(typeof j.audio.token, "string");
  assert.ok(j.audio.token.split(".").length === 3, "JWT");
  assert.equal(j.audio.url, process.env.LIVEKIT_URL);

  const r = await A.client.req("room:inviteDm", { roomId: publicRoom, to: [id(B)] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.sent, 1);
  const dm = await waitFor(() => inB.find((e) => e.ev === "dm:message" && e.data.kind === "room_invite"));
  assert.equal(dm.data.roomId, publicRoom);
  assert.equal(dm.data.fromId, id(A));
  assert.match(dm.data.text, /Late night builders/);

  const cards = await B.client.req("room:cards", { roomIds: [publicRoom] });
  assert.ok(cards.ok);
  const card = cards.cards[0];
  assert.equal(card.title, "Late night builders");
  assert.equal(card.ended, false);
  assert.equal(card.canJoin, true);
  assert.equal(card.hosts[0].id, id(A));
  assert.equal(card.speakerCount, 1);
  assert.equal(card.listenerCount, 0);
  assert.equal(cards.audioUrl, process.env.LIVEKIT_URL);

  // someone joins → card watchers get a coalesced live update with the new listener count
  const t0 = Date.now();
  await C.client.req("room:join", { roomId: publicRoom });
  const upd = await waitFor(() => {
    const x = lastCard(inB, publicRoom);
    return x && x.listenerCount === 1 ? x : null;
  });
  assert.equal(upd.speakers[0].id, id(A));
  assert.ok(Date.now() - t0 < 1000, "card update within 1s");
});

test("the same live room invited twice → one card, not a duplicate", async () => {
  const before = inB.filter((e) => e.ev === "dm:message").length;
  const r = await A.client.req("room:inviteDm", { roomId: publicRoom, to: [id(B)] });
  assert.ok(r.ok);
  await sleep(200);
  assert.equal(inB.filter((e) => e.ev === "dm:message").length, before);
  const h = await B.client.req("dm:history", { peerId: id(A) });
  assert.equal(h.messages.filter((m: any) => m.kind === "room_invite").length, 1);
});

test("invite cards persist (kind + room_id) and come back in history", async () => {
  await sleep(1200); // store flush debounce
  const rows = await sql<{ kind: string; room_id: string }>("SELECT kind, room_id FROM dms WHERE kind IS NOT NULL");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "room_invite");
  assert.equal(rows[0].room_id, publicRoom);
  const mig = await sql<{ version: string }>("SELECT version FROM schema_migrations WHERE version = '013_dm_room_invites.sql'");
  assert.equal(mig.length, 1);
});

test("validation: no recipients, too many, unknown room, self", async () => {
  assert.equal((await A.client.req("room:inviteDm", { roomId: publicRoom, to: [] })).ok, false);
  assert.equal((await A.client.req("room:inviteDm", { roomId: publicRoom, to: Array.from({ length: 21 }, (_, i) => `u_${i}`) })).ok, false);
  assert.equal((await A.client.req("room:inviteDm", { roomId: "nope1234", to: [id(B)] })).ok, false);
  assert.equal((await A.client.req("room:inviteDm", { roomId: publicRoom, to: [id(A)] })).ok, false);
});

test("pasted room link: room:cards works for any live public room; unknown rooms are 'ended'", async () => {
  const r = await C.client.req("room:cards", { roomIds: [publicRoom, "gone0000"] });
  assert.equal(r.cards[0].ended, false);
  assert.equal(r.cards[0].canJoin, true);
  assert.equal(r.cards[1].ended, true);
  assert.equal(r.cards[1].canJoin, false);
});

test("room ends → every card flips to Ended immediately", async () => {
  inB.length = 0;
  const t0 = Date.now();
  assert.ok((await A.client.req("room:end", { roomId: publicRoom })).ok);
  const card = await waitFor(() => {
    const x = lastCard(inB, publicRoom);
    return x?.ended ? x : null;
  });
  assert.equal(card.canJoin, false);
  assert.ok(Date.now() - t0 < 300, `ended pushed in ${Date.now() - t0}ms`);
  assert.equal((await A.client.req("room:inviteDm", { roomId: publicRoom, to: [id(B)] })).ok, false, "can't invite to an ended room");
});

let dropRoom = "";

test("drop-in: private room for the two of us, card in the DM, hidden from the hallway", async () => {
  inB.length = 0;
  const r = await A.client.req("dropin:start", { peerId: id(B) });
  assert.ok(r.ok, JSON.stringify(r));
  dropRoom = r.roomId;
  assert.equal(r.card.dropin, true);
  assert.equal(r.card.private, true);
  const dm = await waitFor(() => inB.find((e) => e.ev === "dm:message" && e.data.kind === "dropin"));
  assert.equal(dm.data.roomId, dropRoom);
  const list = await C.client.req("rooms:list", {});
  assert.ok(!list.rooms.some((x: any) => x.id === dropRoom), "not in the hallway");
  // the host joins, then the invited peer joins from the card in one request
  assert.ok((await A.client.req("room:join", { roomId: dropRoom })).ok);
  const t0 = performance.now();
  const jb = await B.client.req("room:join", { roomId: dropRoom });
  const ms = performance.now() - t0;
  assert.ok(jb.ok, JSON.stringify(jb));
  assert.equal(jb.room.private, true);
  assert.equal(jb.room.dropin, true);
  assert.equal(typeof jb.audio.token, "string");
  console.log(`# drop-in join ack (seat + LiveKit token) in ${ms.toFixed(1)} ms`);
});

test("drop-in: outsiders can't join or peek; pressing start again reuses the live one", async () => {
  const jc = await C.client.req("room:join", { roomId: dropRoom });
  assert.equal(jc.ok, false);
  assert.match(jc.error, /invite-only/);
  const peek = await C.client.req("room:cards", { roomIds: [dropRoom] });
  assert.equal(peek.cards[0].canJoin, false);
  assert.equal(peek.cards[0].title, "", "title not leaked");
  assert.deepEqual(peek.cards[0].speakers, []);
  const tok = await api(app.base, "/api/livekit/token", { roomId: dropRoom }, { token: C.res.access });
  assert.equal(tok.status, 403, "no LiveKit token for outsiders");
  const again = await B.client.req("dropin:start", { peerId: id(A) });
  assert.ok(again.ok);
  assert.equal(again.roomId, dropRoom);
  assert.equal(again.reused, true);
});

test("drop-in: a participant can invite a third person, who then may join", async () => {
  const r = await B.client.req("room:inviteDm", { roomId: dropRoom, to: [id(C)] });
  assert.ok(r.ok, JSON.stringify(r));
  const jc = await C.client.req("room:join", { roomId: dropRoom });
  assert.ok(jc.ok, JSON.stringify(jc));
  // an outsider can't invite themselves in via someone else
  await C.client.req("room:leave", { roomId: dropRoom });
});

test("drop-in: is never persisted and auto-ends once empty", async () => {
  await sleep(1000);
  const rows = await sql("SELECT id FROM rooms WHERE id = $1", [dropRoom]);
  assert.equal(rows.length, 0);
  inA.length = 0;
  await A.client.req("room:leave", { roomId: dropRoom });
  await B.client.req("room:leave", { roomId: dropRoom });
  const card = await waitFor(() => {
    const x = lastCard(inA, dropRoom);
    return x?.ended ? x : null;
  }, 6000);
  assert.equal(card.ended, true);
  assert.equal((await B.client.req("room:join", { roomId: dropRoom })).ok, false);
});

test("blocks: no invite cards and no drop-ins either way", async () => {
  const blk = await api(app.base, "/api/me/blocks", { userId: id(A), block: true }, { token: C.res.access });
  assert.equal(blk.status, 200);
  const d1 = await A.client.req("dropin:start", { peerId: id(C) });
  assert.equal(d1.ok, false);
  const d2 = await C.client.req("dropin:start", { peerId: id(A) });
  assert.equal(d2.ok, false);
  const c = await A.client.req("room:create", { title: "Blocked test" });
  await A.client.req("room:join", { roomId: c.roomId });
  const inv = await A.client.req("room:inviteDm", { roomId: c.roomId, to: [id(C)] });
  assert.equal(inv.ok, false);
  await A.client.req("room:end", { roomId: c.roomId });
  await api(app.base, "/api/me/blocks", { userId: id(A), block: false }, { token: C.res.access });
});

test("rate limit: drop-in starts per user are capped", async () => {
  // A already started 1 (reuse doesn't count); the cap is 4 / 10 min in this env
  const D = await phoneLogin(app.wsUrl, phone(), { firstName: "Dee", username: `dee_${uniq()}` });
  let okCount = 0;
  let limited = false;
  for (let i = 0; i < 6; i++) {
    const peer = await phoneLogin(app.wsUrl, phone(), { firstName: `P${i}`, username: `p${i}_${uniq()}` });
    const r = await D.client.req("dropin:start", { peerId: id(peer) });
    if (r.ok) okCount++;
    else if (/slow down/i.test(r.error)) limited = true;
    peer.client.close();
  }
  assert.equal(okCount, 4);
  assert.ok(limited);
  D.client.close();
});

test("schema: room:create can't smuggle a private flag", async () => {
  const r = await A.client.req("room:create", { title: "sneaky", private: true, dropin: true, allowed: [id(A)] });
  assert.ok(r.ok);
  const list = await C.client.req("rooms:list", {});
  assert.ok(list.rooms.some((x: any) => x.id === r.roomId), "public like any other room");
  await A.client.req("room:join", { roomId: r.roomId });
  await A.client.req("room:end", { roomId: r.roomId });
});
