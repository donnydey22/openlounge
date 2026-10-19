// Hang-up noise: a late ms:leave on an already-ended call is logged at info, real media failures still warn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isBenignMediaFailure } from "../../server/calls/mediaLog";

test("late leave on ended call is benign", () => {
  assert.equal(isBenignMediaFailure("leave", "UDP media isn't available"), true);
});

test("other leave errors and other methods still warn", () => {
  assert.equal(isBenignMediaFailure("leave", "UDP media credential expired"), false);
  assert.equal(isBenignMediaFailure("join", "UDP media isn't available"), false);
  assert.equal(isBenignMediaFailure("transport:connect", "UDP media isn't available"), false);
  assert.equal(isBenignMediaFailure("leave", undefined), false);
});

test("relay still acks the original result and keeps the warn path", () => {
  const src = readFileSync(new URL("../../server/calls/index.ts", import.meta.url), "utf8");
  assert.match(src, /\.error\)\) \{\s*log\.info\("\[calls\] media leave after call end"[^;]*;\s*return ack\(r\);/);
  assert.match(src, /log\.warn\("\[calls\] media request failed"/);
});
