// Oct 16 2026: native iOS parity with web — no Opus DTX, faster ICE-restart cadence, full settable mic gain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
test('native producer: Opus DTX off, FEC on', () => {
  const s = src('src/nativeMedia.ts');
  assert.match(s, /opusDtx: false/);
  assert.match(s, /opusFec: true/);
});
test('ICE restart cadence back to UDP starts at 0/500 ms', () => {
  assert.match(src('src/nativeMedia.ts'), /const delays = \[0, 500, 1000, 2000, 4000\]/);
});
test('AVAudioSession input gain raised only when settable', () => {
  assert.match(src('modules/openlounge-calls/ios/OLCallManager.swift'), /if s\.isInputGainSettable && s\.inputGain < 1\.0 \{ try\? s\.setInputGain\(1\.0\) \}/);
});
