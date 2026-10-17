import { test } from "node:test";
import assert from "node:assert/strict";
import { CALL_AUDIO_CONSTRAINTS, OPUS_VOICE_CODEC_OPTIONS, useRawDirectCallMicrophone } from "../../src/lib/calls/audioPolicy";

test("call capture asks for browser AEC, noise suppression, AGC, and efficient full-band mono without making any capability mandatory", () => {
  assert.deepEqual(CALL_AUDIO_CONSTRAINTS.echoCancellation, { ideal: true });
  assert.deepEqual(CALL_AUDIO_CONSTRAINTS.noiseSuppression, { ideal: true });
  assert.deepEqual(CALL_AUDIO_CONSTRAINTS.autoGainControl, { ideal: true });
  assert.deepEqual(CALL_AUDIO_CONSTRAINTS.channelCount, { ideal: 1 });
  assert.deepEqual(CALL_AUDIO_CONSTRAINTS.sampleRate, { ideal: 48_000 });
});

test("UDP Mediasoup voice producer requests Opus FEC (DTX off) without stereo overhead", () => {
  assert.deepEqual(OPUS_VOICE_CODEC_OPTIONS, {
    opusFec: true,
    opusDtx: false,
    opusStereo: false,
    opusMaxPlaybackRate: 48_000,
    opusMaxAverageBitrate: 48_000,
    opusPtime: 20,
  });
});

test("native direct calls keep the browser's raw AEC/NS/AGC microphone instead of a fragile Web Audio destination", () => {
  assert.equal(useRawDirectCallMicrophone({ nativePlatform: "ios" }), true);
  assert.equal(useRawDirectCallMicrophone({ nativePlatform: "android" }), true);
  assert.equal(useRawDirectCallMicrophone({ ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8)" }), true);
  assert.equal(useRawDirectCallMicrophone({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/123" }), false);
});

test("Android voice floor: ladder never takes Android Opus below 24 kbps; iOS/web ladder unchanged", async () => {
  const { voiceLadderBps, ANDROID_VOICE_FLOOR_BPS } = await import("../../src/lib/calls/audioPolicy");
  const android = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36";
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
  assert.equal(ANDROID_VOICE_FLOOR_BPS, 24_000);
  assert.equal(voiceLadderBps(16_000, android), 24_000);
  assert.equal(voiceLadderBps(48_000, android), 48_000);
  assert.equal(voiceLadderBps(32_000, android), 32_000);
  assert.equal(voiceLadderBps(16_000, iphone), 16_000);
  assert.equal(voiceLadderBps(16_000, ""), 16_000);
});

test("audio-levels telemetry: wrapper flag is 'app', it no longer overwrites the native-media flag", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.ok(src.includes("app: String(!!w.__olNativeCalls),"));
  assert.ok(!src.includes("native: String(!!w.__olNativeCalls)"));
});
