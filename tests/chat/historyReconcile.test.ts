import { test } from "node:test";
import assert from "node:assert/strict";
import { appendNewer, cacheWindow, mergeForCache, newestConfirmed, reconcileNewest, reconcileOlder } from "../../src/lib/chat/historyReconcile";

type M = { id: string; createdAt: number; clientId?: string; state?: string; text?: string };
const m = (i: number, extra: Partial<M> = {}): M => ({ id: `m${i}`, createdAt: 1000 + i, ...extra });

test("newest page wins inside its range: a cached message deleted on the server disappears, older cache stays", () => {
  const cached = [m(1), m(2), m(3), m(4), m(5), m(6)];
  const page = [m(4), m(6)]; // m5 was deleted for everyone while we were away
  const out = reconcileNewest(cached, page, true);
  assert.deepEqual(out.map((x) => x.id), ["m1", "m2", "m3", "m4", "m6"]);
});

test("hasMore=false: the page is the whole history (stale older cache dropped)", () => {
  const out = reconcileNewest([m(1), m(2), m(3)], [m(2), m(3)], false);
  assert.deepEqual(out.map((x) => x.id), ["m2", "m3"]);
});

test("pending sends survive reconcile until the server copy (same clientId) arrives — never duplicated", () => {
  const pending = { id: "tmp1", createdAt: 9999, clientId: "c1", state: "sending" };
  const a = reconcileNewest([m(1), pending], [m(1)], false);
  assert.deepEqual(a.map((x) => x.id), ["m1", "tmp1"]);
  const b = reconcileNewest(a, [m(1), m(2, { clientId: "c1" })], false);
  assert.deepEqual(b.map((x) => x.id), ["m1", "m2"]);
});

test("older page replaces its range and keeps everything newer", () => {
  const cur = [m(5), m(6), m(7)];
  const out = reconcileOlder(cur, [m(2), m(3), m(4)]);
  assert.deepEqual(out.map((x) => x.id), ["m2", "m3", "m4", "m5", "m6", "m7"]);
  const again = reconcileOlder(out, [m(3), m(4)]); // overlapping refetch: no duplicates
  assert.equal(new Set(again.map((x) => x.id)).size, again.length);
});

test("cache keeps every confirmed row (no window) and merges: reopening with only the newest page never shrinks it", () => {
  const list = Array.from({ length: 2000 }, (_, i) => m(i));
  list.push({ id: "tmp", createdAt: 1e9, state: "sending" });
  assert.equal(cacheWindow(list).length, 2000);
  const merged = mergeForCache(list.slice(0, 2000), false, [m(1960, { text: "edited" }), m(1999), m(2000)], true);
  assert.equal(merged.messages.length, 1960 + 3); // m0..m1959 kept; m1961..m1998 were deleted on the server
  assert.equal(merged.messages[0].id, "m0");
  assert.equal(merged.hasMore, false); // cached rows reach #1
  assert.equal(merged.messages.find((x) => x.id === "m1960")!.text, "edited");
});

test("since-cursor top-up appends newer messages once, swaps my pending send for its server copy", () => {
  const cur = [m(1), m(2), { id: "tmp", createdAt: 5000, clientId: "c9", state: "sending" }];
  const out = appendNewer(cur, [m(3), m(4, { clientId: "c9" })]);
  assert.deepEqual(out.map((x) => x.id), ["m1", "m2", "m3", "m4"]);
  assert.equal(newestConfirmed(out)!.id, "m4");
  assert.deepEqual(appendNewer(out, [m(4)]).map((x) => x.id), ["m1", "m2", "m3", "m4"]);
});

test("a cache from before a long gap never leaves a hole: disconnected older rows are not shown / are set aside", () => {
  const cached = [m(1), m(2), m(3)];
  const page = [m(100), m(101)]; // 96 messages arrived meanwhile, the newest page doesn't reach the cache
  assert.deepEqual(reconcileNewest(cached, page, true).map((x) => x.id), ["m100", "m101"]);
  const merged = mergeForCache(cached, false, page, true);
  assert.equal(merged.disconnected, true);
  assert.deepEqual(merged.messages.map((x) => x.id), ["m100", "m101"]);
  assert.equal(merged.hasMore, true);
});
