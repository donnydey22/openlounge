import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RING_PEAK, ringGain } from "../../src/lib/calls/tones";

test("incoming ringtone peaks near -3 dBFS", () => {
  assert.ok(Math.abs(20 * Math.log10(RING_PEAK) + 3) < 0.05);
  assert.ok(Math.abs(2 * 0.16 * ringGain("incoming") - RING_PEAK) < 1e-6);
});
test("outgoing ringback level unchanged", () => assert.equal(ringGain("outgoing"), 1));
test("fallback WAV rendered at 48 kHz and normalized; native session prepared before the incoming tone", () => {
  const src = readFileSync("src/lib/calls/tones.ts", "utf8");
  assert.match(src, /const WAV_RATE = 48000;/);
  assert.match(src, /pcm\[i\] \*= RING_PEAK \/ pk/);
  assert.match(src, /if \(kind === "incoming"\) postNativeRingtonePrepare\(\);/);
  assert.match(src, /type: "call:ringtonePrepare"/);
});
