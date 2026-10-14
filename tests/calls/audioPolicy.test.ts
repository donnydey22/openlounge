import { test } from "node:test";
import assert from "node:assert/strict";
import { CALL_AUDIO_CONSTRAINTS, OPUS_VOICE_CODEC_OPTIONS } from "../../src/lib/calls/audioPolicy";

test("call capture asks for browser AEC, noise suppression, AGC, and efficient full-band mono without making any capability mandatory", () => {
  assert.deepEqual(CALL_AUDIO_CONSTRAINTS.echoCancellation, { ideal: true });
  assert.deepEqual(CALL_AUDIO_CONSTRAINTS.noiseSuppression, { ideal: true });
  assert.deepEqual(CALL_AUDIO_CONSTRAINTS.autoGainControl, { ideal: true });
  assert.deepEqual(CALL_AUDIO_CONSTRAINTS.channelCount, { ideal: 1 });
  assert.deepEqual(CALL_AUDIO_CONSTRAINTS.sampleRate, { ideal: 48_000 });
});

test("UDP Mediasoup voice producer requests Opus FEC and DTX without stereo overhead", () => {
  assert.deepEqual(OPUS_VOICE_CODEC_OPTIONS, {
    opusFec: true,
    opusDtx: true,
    opusStereo: false,
    opusMaxPlaybackRate: 48_000,
    opusMaxAverageBitrate: 48_000,
  });
});
