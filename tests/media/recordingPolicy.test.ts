import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_AUDIO_CAPTURE_CONSTRAINTS,
  VIDEO_NOTE_AUDIO_BITS_PER_SECOND,
  VIDEO_NOTE_CAPTURE_CONSTRAINTS,
  VIDEO_NOTE_VIDEO_BITS_PER_SECOND,
  VOICE_NOTE_AUDIO_BITS_PER_SECOND,
} from "../../src/lib/media/recordingPolicy";

test("chat voice and video capture requests browser voice processing without requiring it", () => {
  assert.deepEqual(CHAT_AUDIO_CAPTURE_CONSTRAINTS.echoCancellation, { ideal: true });
  assert.deepEqual(CHAT_AUDIO_CAPTURE_CONSTRAINTS.noiseSuppression, { ideal: true });
  assert.deepEqual(CHAT_AUDIO_CAPTURE_CONSTRAINTS.autoGainControl, { ideal: true });
  assert.deepEqual(CHAT_AUDIO_CAPTURE_CONSTRAINTS.channelCount, { ideal: 1 });
  assert.deepEqual(CHAT_AUDIO_CAPTURE_CONSTRAINTS.sampleRate, { ideal: 48_000 });
});

test("chat message encoders preserve clear voice and a compact 720-square video note", () => {
  assert.equal(VOICE_NOTE_AUDIO_BITS_PER_SECOND, 64_000);
  assert.deepEqual(VIDEO_NOTE_CAPTURE_CONSTRAINTS, {
    width: { ideal: 720 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
  });
  assert.equal(VIDEO_NOTE_VIDEO_BITS_PER_SECOND, 1_500_000);
  assert.equal(VIDEO_NOTE_AUDIO_BITS_PER_SECOND, 64_000);
});
