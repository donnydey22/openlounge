import { test } from "node:test";
import assert from "node:assert/strict";
import { LADDER, videoBpsFor, videoBpsRecovering } from "../../src/lib/calls/netAdapt";

// Replays Keiko's 30dc469c ladder: estimate 45.7 / 34.8 kbps while clean (loss 0, rtt 58-152).
test("FX-075: clean samples restore video after an application-limited shed", () => {
  const step = LADDER[1];
  let last = videoBpsFor(step, 34.819);
  assert.equal(last, 60_000); // old behaviour: stuck at the floor
  for (let i = 0; i < 6; i++) last = videoBpsRecovering(step, { outKbps: 34.819, lossPercent: 0, rttMs: 58 }, last);
  assert.equal(last, step.videoBps);
});
test("FX-075: lossy or slow samples still track the estimate (no regression)", () => {
  const step = LADDER[1];
  assert.equal(videoBpsRecovering(step, { outKbps: 45.7, lossPercent: 9, rttMs: 506 }, 300_000), videoBpsFor(step, 45.7));
  assert.equal(videoBpsRecovering(step, { outKbps: 300, lossPercent: 0, rttMs: 60 }, null), videoBpsFor(step, 300));
});
