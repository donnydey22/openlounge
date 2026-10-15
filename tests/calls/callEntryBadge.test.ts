// Badge root cause (Donny ↔ Keiko): answered/declined call entries were stamped readAt but still counted as unread
// (the count used only the read pointer), and reading a thread whose only unread items were such entries emitted no
// dm:read-state and no push clear, so other sessions/devices kept a stale row + badge. Server is the source of truth.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import "./env";
import { setTestEnv, startApp, wipeDb, phoneLogin, wsClient, type App } from "../unified-auth/harness";

setTestEnv({ providers: false });
let app: App;
type L = Awaited<ReturnType<typeof phoneLogin>>;
let A: L, B: L;
const uniq = () => randomBytes(3).toString("hex");
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const id = (x: L) => x.res.user.id as string;
function inbox(ws: any) {
  const got: { ev: string; data: any }[] = [];
  ws.on("message", (raw: Buffer) => { const m = JSON.parse(raw.toString()); if (m.t === "evt") got.push({ ev: m.ev, data: m.data }); });
  return got;
}
async function waitFor<T>(fn: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > until) throw new Error("timed out waiting"); await sleep(20); }
}
async function device(x: L) {
  const c = wsClient(app.wsUrl); await c.open;
  assert.ok((await c.req("session:resume", { token: x.res.access ?? x.res.token ?? x.res.refresh })).ok);
  return { c, box: inbox(c.ws) };
}
const rowUnread = async (c: any, peer: string) => ((await c.req("dm:list", {})).conversations.find((x: any) => x.peer.id === peer)?.unread ?? 0) as number;
const total = async (c: any) => (await c.req("dm:list", {})).unread as number;

before(async () => {
  await wipeDb();
  app = await startApp();
  A = await phoneLogin(app.wsUrl, phone(), { firstName: "Keiko", username: `keiko_${uniq()}` });
  B = await phoneLogin(app.wsUrl, phone(), { firstName: "Donny", username: `donny_${uniq()}` });
  assert.ok((await B.client.req("dm:send", { to: id(A), text: "hi" })).ok);
  assert.ok((await A.client.req("dm:send", { to: id(B), text: "hey" })).ok);
  await B.client.req("dm:read", { peerId: id(A) });
});
after(async () => { A?.client.close(); B?.client.close(); await app?.close(); });

async function answeredCall(video: boolean) {
  const r = await A.client.req("call:start", { peerId: id(B), video });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok((await B.client.req("call:accept", { callId: r.call.id })).ok);
  await sleep(50);
  assert.ok((await A.client.req("call:hangup", { callId: r.call.id })).ok);
  await sleep(150);
}

test("an answered video/audio call entry never counts as unread (row, total)", async () => {
  await answeredCall(true);
  await answeredCall(false);
  assert.equal(await rowUnread(B.client, id(A)), 0);
  assert.equal(await total(B.client), 0);
});

test("a declined call entry never counts as unread", async () => {
  const r = await A.client.req("call:start", { peerId: id(B), video: false });
  assert.ok((await B.client.req("call:decline", { callId: r.call.id })).ok);
  await sleep(150);
  assert.equal(await rowUnread(B.client, id(A)), 0);
});

test("a missed call entry counts once; reading it on one device updates the row + total on the others (dm:read-state)", async () => {
  const other = await device(B);
  const r = await A.client.req("call:start", { peerId: id(B), video: true });
  assert.ok((await A.client.req("call:hangup", { callId: r.call.id })).ok); // caller gives up → missed for B
  await waitFor(() => other.box.find((e) => e.ev === "dm:unread" && e.data.count === 1));
  assert.equal(await rowUnread(B.client, id(A)), 1);
  // the newest item is the (unread) call entry; reading it must reconcile every session even though no receipt is owed
  // for answered entries in between
  await answeredCall(true);
  assert.equal(await rowUnread(B.client, id(A)), 1, "answered entry after the missed one adds nothing");
  await B.client.req("dm:read", { peerId: id(A) });
  const st = await waitFor(() => other.box.find((e) => e.ev === "dm:read-state" && e.data.peerId === id(A)));
  assert.deepEqual([st.data.unread, st.data.total], [0, 0]);
  other.c.close();
});

test("thread whose only new items are pre-read call entries: reading still emits dm:read-state to other sessions", async () => {
  const other = await device(B);
  await answeredCall(false);
  const before = other.box.length;
  await B.client.req("dm:read", { peerId: id(A) });
  await waitFor(() => other.box.slice(before).find((e) => e.ev === "dm:read-state" && e.data.peerId === id(A)));
  other.c.close();
});

test("older unread messages are NOT cleared by an answered call entry arriving after them", async () => {
  assert.ok((await A.client.req("dm:send", { to: id(B), text: "are you there?" })).ok);
  assert.ok((await A.client.req("dm:send", { to: id(B), text: "call me" })).ok);
  await answeredCall(false);
  assert.equal(await rowUnread(B.client, id(A)), 2);
  assert.equal(await total(B.client), 2);
});
