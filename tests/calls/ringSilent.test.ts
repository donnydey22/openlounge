// Regression: silent ring. The <audio> priming used a header-only WAV (empty data chunk) that Firefox/WebKit refuse to
// decode, so the element was never primed and the ring fallback had nothing to play when Web Audio wasn't running.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { silentWavBytes } from "../../src/lib/audioUnlock";
import { ringUntil } from "../../src/lib/calls/engine";

test("priming WAV has real samples (non-empty data chunk, valid RIFF sizes)", () => {
  const b = silentWavBytes();
  const v = new DataView(b.buffer);
  assert.equal(String.fromCharCode(...b.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...b.slice(36, 40)), "data");
  const data = v.getUint32(40, true);
  assert.ok(data >= 800, `data chunk ${data} bytes`);
  assert.equal(v.getUint32(4, true), 36 + data);
  assert.equal(b.length, 44 + data);
  assert.doesNotMatch(readFileSync("src/lib/audioUnlock.ts", "utf8"), /ZGF0YQAAAAA=/); // old empty "data" chunk
});
test("ring fallback does not require a successfully primed element", () => {
  assert.match(readFileSync("src/lib/calls/tones.ts", "utf8"), /ringAudioElement as primedAudioElement/);
});
test("ring window is never already expired (missing / bad server fields → 45 s)", () => {
  const now = 1_000_000;
  for (const c of [{ createdAt: now, expiresAt: now + 45_000 }, { createdAt: undefined as unknown as number, expiresAt: now }, { createdAt: 0, expiresAt: 0 }, { createdAt: now + 9e9, expiresAt: now }])
    assert.ok(ringUntil(c, now) - now >= 45_000, JSON.stringify(c));
});
test("iOS wrapper resume hook re-arms the ring", () => {
  assert.match(readFileSync("src/lib/calls/tones.ts", "utf8"), /__olRingResume = \(\) =>[\s\S]{0,200}resumeAudio\(\)[\s\S]{0,200}e\.play\(\)/);
});
