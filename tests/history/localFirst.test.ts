// Local-first chat cache + virtualized thread invariants (source-level; no IndexedDB in node).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const store = readFileSync("src/lib/chat/msgStore.ts", "utf8");
const thread = readFileSync("src/components/chat/DmThread.tsx", "utf8");
const cache = readFileSync("src/lib/chat/historyCache.ts", "utf8");
test("msgStore is append-only: no row delete/clear, deletes are tombstones", () => {
  assert.doesNotMatch(store, /\.delete\(|\.clear\(/);
  assert.match(store, /gone/);
  assert.match(store, /export function markGone/);
});
test("cache rows are chained so gaps are never skipped", () => { assert.match(store, /prev/); });
test("sign-out wipes the per-message DB", () => { assert.match(cache, /wipeMsgStore/); });
test("thread opens from cache then syncs newest; older pages cache-first", () => {
  assert.match(thread, /readNewest[<(]/); assert.match(thread, /readOlder[<(]/); assert.match(thread, /putPage[<(]/);
  assert.match(thread, /beforeId/);
});
test("thread is virtualized with no render cap", () => {
  assert.doesNotMatch(thread, /RENDER_WINDOW/);
  assert.match(thread, /dm-vspace-top/); assert.match(thread, /data-vrow/);
});
