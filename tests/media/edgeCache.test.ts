// Railway edge CDN safety: signed media responses on the public port are cacheable only while the link is valid (<= 10 min).
import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeCache, EDGE_MAX_S } from "../../server/media/origin";

const IMM = "public, max-age=31536000, immutable";
const now = 1_800_000_000_000;
const s = now / 1000;

test("immutable media is bounded by the remaining link lifetime", () => {
  assert.equal(edgeCache(IMM, s + 120, now), "public, max-age=120, s-maxage=120");
});
test("never longer than EDGE_MAX_S even for long video links", () => {
  assert.equal(EDGE_MAX_S, 600);
  assert.equal(edgeCache(IMM, s + 3600, now), "public, max-age=600, s-maxage=600");
});
test("short origin max-age (processing playlists) stays short", () => {
  assert.equal(edgeCache("public, max-age=5, stale-while-revalidate=5", s + 500, now), "public, max-age=5, s-maxage=5");
});
test("view-once / timed (no-store) and private responses pass through unchanged", () => {
  assert.equal(edgeCache("no-store", s + 500, now), "no-store");
  assert.equal(edgeCache("private, max-age=60", s + 500, now), "private, max-age=60");
});
test("expired or missing exp → no-store", () => {
  assert.equal(edgeCache(IMM, s - 1, now), "no-store");
  assert.equal(edgeCache(IMM, NaN, now), "no-store");
});
