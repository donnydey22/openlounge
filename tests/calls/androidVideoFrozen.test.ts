// FROZEN BASELINE (Donny, 2026-10-14): Android video config from the Keiko Android↔Android call (3f76d74b, 23:09 PT,
// commit f065072, published 720×1280 H.264 simulcast). Any change here is a deliberate baseline change, never a tweak.
// iPhone may be tuned toward this; Android is never tuned toward anything else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VIDEO_LAYERS, VIDEO_LAYERS_PORTRAIT, AUDIO_SPEECH, chooseVideoCodec } from "../../src/lib/calls/videoPolicy";

test("Android video unchanged: portrait simulcast layers (resolution / bitrate / fps)", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(VIDEO_LAYERS_PORTRAIT)), {
    low: { width: 180, height: 320, maxBitrate: 150_000, maxFramerate: 15 },
    mid: { width: 360, height: 640, maxBitrate: 400_000, maxFramerate: 24 },
    top: { width: 720, height: 1280, maxBitrate: 1_200_000, maxFramerate: 30 },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(VIDEO_LAYERS)), {
    low: { width: 320, height: 180, maxBitrate: 150_000, maxFramerate: 15 },
    mid: { width: 640, height: 360, maxBitrate: 400_000, maxFramerate: 24 },
    top: { width: 1280, height: 720, maxBitrate: 1_200_000, maxFramerate: 30 },
  });
});

test("Android video unchanged: H.264 on an Android phone that can send it, mic Opus 48 kbps high priority", () => {
  const caps = { codecs: [{ mimeType: "video/H264", sdpFmtpLine: "profile-level-id=42e01f;packetization-mode=1" }, { mimeType: "video/VP8" }] };
  const c = chooseVideoCodec({ ua: "Mozilla/5.0 (Linux; Android 16; Pixel 10 Pro) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36", maxTouchPoints: 5, nativePlatform: "android", caps } as never);
  assert.equal(c.codec, "h264");
  assert.deepEqual({ ...AUDIO_SPEECH }, { maxBitrate: 48_000, priority: "high" });
});
