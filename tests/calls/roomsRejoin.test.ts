import { test } from "node:test";
import assert from "node:assert/strict";
import { rejoinDelayMs } from "../../src/hooks/useLiveKitAudio";

test("rooms audio rejoin backoff: 1 s, 2 s, 4 s, 8 s, then capped at 10 s", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 20].map(rejoinDelayMs), [1000, 2000, 4000, 8000, 10000, 10000, 10000]);
  assert.equal(rejoinDelayMs(-1), 1000);
});
