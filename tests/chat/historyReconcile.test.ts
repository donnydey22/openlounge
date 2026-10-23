import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_THREAD_WINDOW, cacheWindow, reconcileNewest, reconcileOlder } from "../../src/lib/chat/historyReconcile";

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

test("cache window keeps the newest confirmed messages only (older pages stay re-fetchable from the server)", () => {
  const list = Array.from({ length: CACHE_THREAD_WINDOW + 50 }, (_, i) => m(i));
  list.push({ id: "tmp", createdAt: 1e9, state: "sending" });
  const w = cacheWindow(list);
  assert.equal(w.length, CACHE_THREAD_WINDOW);
  assert.equal(w[0].id, "m50");
  assert.ok(!w.some((x) => x.state));
});
