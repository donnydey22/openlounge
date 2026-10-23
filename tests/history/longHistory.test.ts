// Full history retention + cursor paging over the real WebSocket API (local Postgres only).
// Seeds 5,200 1:1 messages and 5,100 group messages (every 20th carries media), then every member pages back with
// 40-message cursor pages to message #1: same count, same order, no gaps, no duplicates — and nothing is trimmed
// from memory or deleted from Postgres when new messages arrive (the old 1000/conversation cap did both).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import "./env";
import { setTestEnv, startApp, wipeDb, phoneLogin, sql, type App } from "../unified-auth/harness";
import { pageBefore } from "../../server/chat/paging";

setTestEnv({ providers: false });
let app: App;
type L = Awaited<ReturnType<typeof phoneLogin>>;
let A: L, B: L, C: L;
const uniq = () => randomBytes(3).toString("hex");
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const id = (x: L) => x.res.user.id as string;
const DM_N = 5200;
const GROUP_N = 5100;
let gid = "";
let store: typeof import("../../server/store").store;

function seed(key: string, n: number, members: string[], to: (from: string) => string) {
  const t0 = Date.now() - n * 1000 - 60_000;
  const list = store.dms.get(key) ?? [];
  for (let i = 1; i <= n; i++) {
    const from = members[i % members.length];
    // every 7th pair shares a timestamp: the old timestamp cursor skipped messages at a page boundary on ties
    const createdAt = t0 + Math.floor(i / 2) * 1000;
    const media = i % 20 === 0 ? { media: { id: `seed${i}`.padEnd(32, "0"), kind: "photo", w: 1200, h: 800, ph: "data:image/webp;base64,AA" } } : {};
    list.push({ id: `${key.slice(0, 6)}-${String(i).padStart(6, "0")}`, fromId: from, fromName: "x", fromColor: "#888", toId: to(from), text: `#${i}`, createdAt, readAt: createdAt, ...media } as never);
  }
  list.sort((a, b) => a.createdAt - b.createdAt);
  store.dms.set(key, list);
  store.saveSoon();
}

// real clients are held to the socket's token bucket (20 req/s, burst 60): page at ~14/s like the web client's prefetch
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function hist(x: L, q: Record<string, unknown>) {
  await sleep(70);
  return x.client.req("dm:history", q);
}

async function pageAll(x: L, peerId: string) {
  const seen: string[] = [];
  let r = await hist(x, { peerId, limit: 40 });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
  let pages = 1;
  seen.unshift(...r.messages.map((m: any) => m.text));
  while (r.hasMore) {
    assert.ok(r.messages.length <= 40);
    r = await hist(x, { peerId, limit: 40, beforeId: r.messages[0].id });
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
    seen.unshift(...r.messages.map((m: any) => m.text));
    pages++;
    assert.ok(pages < 1000, "runaway paging");
  }
  return { seen, pages };
}

before(async () => {
  await wipeDb();
  app = await startApp();
  ({ store } = await import("../../server/store"));
  const mk = (n: string) => phoneLogin(app.wsUrl, phone(), { firstName: n, username: `${n.toLowerCase()}_${uniq()}` });
  [A, B, C] = await Promise.all(["Hana", "Omar", "Lea"].map(mk));
  const g = await A.client.req("group:create", { title: "Long history", memberIds: [id(B), id(C)] });
  assert.equal(g.ok, true, JSON.stringify(g));
  gid = g.group.id;
  const dmKey = [id(A), id(B)].sort().join("|");
  seed(dmKey, DM_N, [id(A), id(B)], (f) => (f === id(A) ? id(B) : id(A)));
  seed(gid, GROUP_N, [id(A), id(B), id(C)], () => gid);
  await store.flush();
});
after(async () => {
  for (const x of [A, B, C]) x?.client.close();
  await app?.close();
});

test("pageBefore: id cursor never skips or repeats messages that share a timestamp", () => {
  const list = Array.from({ length: 101 }, (_, i) => ({ id: `m${i}`, createdAt: 1000 + Math.floor(i / 3) }));
  const got: string[] = [];
  let p = pageBefore(list, { limit: 10 });
  got.unshift(...p.messages.map((m) => m.id));
  while (p.hasMore) {
    p = pageBefore(list, { limit: 10, beforeId: p.messages[0].id });
    got.unshift(...p.messages.map((m) => m.id));
  }
  assert.deepEqual(got, list.map((m) => m.id));
  // legacy timestamp cursor still works (and an unknown id falls back to it)
  assert.equal(pageBefore(list, { before: 1010, beforeId: "gone", limit: 500 }).messages.length, 30);
});

test("1:1: both members page back to message #1 with identical, complete histories", async () => {
  const a = await pageAll(A, id(B));
  const b = await pageAll(B, id(A));
  for (const r of [a, b]) {
    assert.equal(r.seen.length, DM_N);
    assert.equal(r.seen[0], "#1");
    assert.equal(r.seen.at(-1), `#${DM_N}`);
    assert.equal(new Set(r.seen).size, DM_N, "no duplicates");
  }
  assert.deepEqual(a.seen, b.seen);
  assert.equal(a.pages, Math.ceil(DM_N / 40));
});

test("group: every member (owner and members) pages back to message #1 with the same count", async () => {
  const runs = await Promise.all([A, B, C].map((x) => pageAll(x, gid)));
  const counts = runs.map((r) => r.seen.filter((t) => /^#\d+$/.test(t)).length);
  assert.deepEqual(counts, [GROUP_N, GROUP_N, GROUP_N]);
  for (const r of runs) assert.equal(r.seen.find((t) => /^#\d+$/.test(t)), "#1");
  assert.deepEqual(runs[1].seen, runs[0].seen);
  assert.deepEqual(runs[2].seen, runs[0].seen);
});

test("new messages never trim history: memory and Postgres keep every seeded row (+ media rows' messages)", async () => {
  const r = await A.client.req("dm:send", { to: id(B), text: "live one", clientId: "live-1" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const g = await B.client.req("dm:send", { to: gid, text: "live group", clientId: "live-g1" });
  assert.equal(g.ok, true, JSON.stringify(g));
  await store.flush();
  const dmKey = [id(A), id(B)].sort().join("|");
  assert.equal(store.dms.get(dmKey)!.length, DM_N + 1);
  assert.ok(store.dms.get(gid)!.length >= GROUP_N + 1);
  const [row] = await sql<{ n: string }>("SELECT count(*)::text AS n FROM dms WHERE conversation_id = $1", [dmKey]);
  assert.equal(Number(row.n), DM_N + 1);
  const [first] = await sql<{ text: string }>("SELECT text FROM dms WHERE conversation_id = $1 ORDER BY created_at, id LIMIT 1", [dmKey]);
  assert.equal(first.text, "#1");
  const again = await pageAll(B, id(A));
  assert.equal(again.seen.length, DM_N + 1);
  assert.equal(again.seen[0], "#1");
});

test("reconnect catch-up pages forward (order: asc) without dropping the middle of a long gap", async () => {
  const dmKey = [id(A), id(B)].sort().join("|");
  const list = store.dms.get(dmKey)!;
  const after = list[list.length - 450].createdAt; // ~450 messages "missed" while offline
  const got: string[] = [];
  let cursor = after;
  for (let i = 0; i < 20; i++) {
    await sleep(70);
    const r = await B.client.req("dm:since", { after: cursor, order: "asc" });
    assert.equal(r.ok, true);
    for (const m of r.messages) if (!got.includes(m.id)) got.push(m.id);
    if (!r.hasMore) break;
    cursor = r.messages.at(-1).createdAt;
  }
  const expected = new Set(list.filter((m) => m.createdAt >= after).map((m) => m.id));
  for (const x of expected) assert.ok(got.includes(x), "missing " + x);
  // legacy (no order): still the newest 200, unchanged for older clients
  const legacy = await B.client.req("dm:since", { after });
  assert.ok(legacy.messages.some((m: any) => m.text === "live one"));
  assert.equal(legacy.messages.length, 200);
});

test("inbox: dm:list returns the conversation with its last message and the unread total in one call", async () => {
  const r = await B.client.req("dm:list", {});
  assert.equal(r.ok, true);
  const row = r.conversations.find((c: any) => c.peer.id === id(A));
  assert.equal(row.lastMessage.text, "live one");
  assert.equal(typeof r.unread, "number");
  assert.ok(r.unread >= 1);
  const none = await C.client.req("dm:list", {});
  assert.equal(none.conversations.length, 0);
});
