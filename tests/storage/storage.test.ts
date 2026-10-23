// Storage & data: media-only LRU plan, auto-download defaults, report-only allowance formula. Pure, no server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lruEvictions } from "../../src/lib/storage/mediaCache";
import { DEFAULT_AUTO, autoDownloadAllowed } from "../../src/lib/storage/autoDownload";
import { allowance } from "../../server/media/allowance";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

test("LRU evicts least-recently-used media first, only until under the cap, never the item just added", () => {
  const ix = { a: { conv: "x", bytes: 40 * MB, at: 1 }, b: { conv: "y", bytes: 40 * MB, at: 3 }, c: { conv: "x", bytes: 40 * MB, at: 2 }, d: { conv: "z", bytes: 40 * MB, at: 0 } };
  assert.deepEqual(lruEvictions(ix, 200 * MB), [], "under the cap: nothing");
  assert.deepEqual(lruEvictions(ix, 100 * MB), ["d", "a"]);
  assert.deepEqual(lruEvictions(ix, 100 * MB, "d"), ["a", "c"], "the item just stored is kept");
  assert.deepEqual(lruEvictions({}, 0), []);
});

test("auto-download defaults keep today's behaviour on Wi-Fi / mobile data (everything loads); unknown network = Wi-Fi", () => {
  for (const k of ["photo", "video"] as const) {
    assert.equal(DEFAULT_AUTO.wifi[k], true);
    assert.equal(DEFAULT_AUTO.cellular[k], true);
  }
  // no window / localStorage (SSR / node): defaults, never throws
  assert.equal(autoDownloadAllowed("video"), true);
  assert.equal(autoDownloadAllowed("video", "roaming"), false);
  assert.equal(autoDownloadAllowed("photo", "roaming"), true);
});

test("allowance formula: (volume × fill − reserve) / active senders, clamped; report-only", () => {
  const a = allowance({ volumeBytes: 4.9 * GB, activeSenders: 10 });
  assert.equal(a.enforced, false);
  assert.equal(a.usable, Math.round(4.9 * GB * 0.8 - 0.5 * GB));
  assert.equal(a.allowance, Math.round(a.usable / 10));
  assert.equal(allowance({ volumeBytes: 4.9 * GB, activeSenders: 1 }).allowance, 2 * GB, "ceiling");
  assert.equal(allowance({ volumeBytes: 4.9 * GB, activeSenders: 10_000 }).allowance, 250 * MB, "floor");
  assert.equal(allowance({ volumeBytes: 0, activeSenders: 0 }).allowance, 250 * MB);
});
