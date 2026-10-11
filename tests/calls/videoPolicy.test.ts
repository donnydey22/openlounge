// Call video policy: codec choice by capability (H.264 on phones, VP8 backup / fallback) + simulcast layer caps + audio priority.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VideoPreset, AudioPresets } from "livekit-client";
import {
  isPhoneLike,
  canSendH264,
  chooseVideoCodec,
  cameraPublishOptions,
  micPublishOptions,
  publishDefaults,
  publishCamera,
  VIDEO_LAYERS,
  AUDIO_SPEECH,
} from "../../src/lib/calls/videoPolicy";

const UA = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iosApp: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 OpenLoungeiOS",
  ipadDesktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  androidWebView: "Mozilla/5.0 (Linux; Android 7.0; SM-G930F; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  desktopChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  desktopFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
  macSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
};
const vp8 = { mimeType: "video/VP8" };
const h264pm1 = { mimeType: "video/H264", sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f" };
const h264pm0 = { mimeType: "video/H264", sdpFmtpLine: "level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f" };
const capsBoth = { codecs: [vp8, { mimeType: "video/rtx" }, h264pm1, h264pm0] };
const capsVp8 = { codecs: [vp8, { mimeType: "video/VP9" }, { mimeType: "video/rtx" }] };

test("phone detection: iOS, iPadOS desktop UA, Android (phone, tablet, WebView), native wrappers; not desktops", () => {
  for (const ua of [UA.iphoneSafari, UA.iosApp, UA.androidChrome, UA.androidWebView, UA.androidTablet]) assert.equal(isPhoneLike({ ua }), true, ua);
  assert.equal(isPhoneLike({ ua: UA.ipadDesktop, maxTouchPoints: 5 }), true);
  assert.equal(isPhoneLike({ ua: UA.macSafari, maxTouchPoints: 0 }), false);
  assert.equal(isPhoneLike({ ua: UA.desktopChrome }), false);
  assert.equal(isPhoneLike({ ua: UA.desktopFirefox }), false);
  assert.equal(isPhoneLike({ ua: UA.desktopChrome, nativePlatform: "android" }), true);
});

test("H.264 capability: needs a video/H264 entry (packetization-mode=1 when fmtp lines exist)", () => {
  assert.equal(canSendH264(capsBoth), true);
  assert.equal(canSendH264(capsVp8), false);
  assert.equal(canSendH264(null), false);
  assert.equal(canSendH264(undefined), false);
  assert.equal(canSendH264({ codecs: [vp8, h264pm0] }), false);
  assert.equal(canSendH264({ codecs: [vp8, { mimeType: "video/h264" }] }), true);
});

test("codec choice: H.264 + VP8 backup on phones that can encode it", () => {
  for (const ua of [UA.iphoneSafari, UA.iosApp, UA.androidChrome, UA.androidWebView]) {
    const c = chooseVideoCodec({ ua, caps: capsBoth });
    assert.deepEqual([c.codec, c.backup, c.reason], ["h264", "vp8", "phone-h264"], ua);
  }
  const ipad = chooseVideoCodec({ ua: UA.ipadDesktop, maxTouchPoints: 5, caps: capsBoth });
  assert.equal(ipad.codec, "h264");
});

test("codec choice: never H.264 when the browser lacks it (phones fall back to VP8, no backup)", () => {
  for (const caps of [capsVp8, null, undefined, { codecs: [] }]) {
    const c = chooseVideoCodec({ ua: UA.androidWebView, caps });
    assert.deepEqual([c.codec, c.backup, c.reason], ["vp8", false, "phone-no-h264"]);
  }
});

test("codec choice: desktops stay on VP8 even with H.264 available", () => {
  for (const ua of [UA.desktopChrome, UA.desktopFirefox, UA.macSafari]) {
    const c = chooseVideoCodec({ ua, caps: capsBoth });
    assert.deepEqual([c.codec, c.backup], ["vp8", false], ua);
  }
});

test("codec choice: debug override (vp8 always honored, h264 only when capable)", () => {
  assert.equal(chooseVideoCodec({ ua: UA.iphoneSafari, caps: capsBoth, override: "vp8" }).codec, "vp8");
  assert.equal(chooseVideoCodec({ ua: UA.desktopChrome, caps: capsBoth, override: "h264" }).codec, "h264");
  assert.equal(chooseVideoCodec({ ua: UA.desktopChrome, caps: capsVp8, override: "h264" }).codec, "vp8");
});

test("camera options: simulcast layers with per-layer bitrate + frame-rate caps, video priority low", () => {
  const o = cameraPublishOptions({ VideoPreset }, { codec: "vp8", backup: false });
  assert.equal(o.simulcast, true);
  assert.equal(o.videoCodec, "vp8");
  assert.equal(o.backupCodec, false);
  assert.deepEqual(o.videoEncoding, { maxBitrate: 1_200_000, maxFramerate: 30, priority: "low" });
  const [low, mid] = o.videoSimulcastLayers!;
  assert.deepEqual([low.width, low.height, low.encoding.maxBitrate, low.encoding.maxFramerate], [320, 180, 150_000, 15]);
  assert.deepEqual([mid.width, mid.height, mid.encoding.maxBitrate, mid.encoding.maxFramerate], [640, 360, 400_000, 24]);
  assert.ok(mid.encoding.maxFramerate! >= 20 && mid.encoding.maxFramerate! <= 24);
  assert.equal(low.encoding.priority, "low");
  // layers are increasing in both resolution and bitrate (LiveKit orders q < h < f)
  assert.ok(VIDEO_LAYERS.low.maxBitrate < VIDEO_LAYERS.mid.maxBitrate && VIDEO_LAYERS.mid.maxBitrate < VIDEO_LAYERS.top.maxBitrate);
});

test("camera options: H.264 primary carries a VP8 backup codec", () => {
  const o = cameraPublishOptions({ VideoPreset }, { codec: "h264", backup: "vp8" });
  assert.equal(o.videoCodec, "h264");
  assert.deepEqual(o.backupCodec, { codec: "vp8" });
});

test("mic options: full-band Opus voice headroom, DTX + RED and high priority (beats video)", () => {
  const m = micPublishOptions();
  assert.equal(m.dtx, true);
  assert.equal(m.red, true);
  assert.equal(AUDIO_SPEECH.maxBitrate, AudioPresets.music.maxBitrate);
  assert.ok(AUDIO_SPEECH.maxBitrate > AudioPresets.speech.maxBitrate);
  assert.equal(m.audioPreset!.maxBitrate, AUDIO_SPEECH.maxBitrate);
  assert.equal(m.audioPreset!.priority, "high");
  const d = publishDefaults({ VideoPreset }, { codec: "vp8", backup: false });
  assert.equal(d.audioPreset!.priority, "high");
  assert.equal(d.videoEncoding!.priority, "low");
});

test("publishCamera: H.264 publish failure retries once with VP8; VP8 failure propagates", async () => {
  const calls: { videoCodec?: string; backupCodec?: unknown; source?: unknown }[] = [];
  let fail = 1;
  const room = {
    localParticipant: {
      publishTrack: async (_t: unknown, o: { videoCodec?: string; backupCodec?: unknown; source?: unknown }) => {
        calls.push(o);
        if (fail-- > 0) throw new Error("encoder init failed");
        return { ok: true };
      },
    },
  };
  const LK = { VideoPreset, Track: { Source: { Camera: "camera" } } } as never;
  const r = await publishCamera(LK, room as never, {} as never, { codec: "h264", backup: "vp8" });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(calls.map((c) => [c.videoCodec, c.source]), [["h264", "camera"], ["vp8", "camera"]]);
  assert.equal(calls[1].backupCodec, false);
  fail = 1;
  calls.length = 0;
  await assert.rejects(publishCamera(LK, room as never, {} as never, { codec: "vp8", backup: false }));
  assert.equal(calls.length, 1);
});

// ---------- low-bandwidth tier ----------
import { networkTier, captureResolution } from "../../src/lib/calls/videoPolicy";
test("network tier: Data Saver, 2g/3g, slow downlink → low; 4g / missing API → normal; override wins", () => {
  assert.equal(networkTier(null), "normal");
  assert.equal(networkTier({ effectiveType: "4g", downlink: 10 }), "normal");
  assert.equal(networkTier({ effectiveType: "4g", saveData: true }), "low");
  for (const t of ["slow-2g", "2g", "3g"]) assert.equal(networkTier({ effectiveType: t }), "low", t);
  assert.equal(networkTier({ effectiveType: "4g", downlink: 0.9 }), "low");
  assert.equal(networkTier({ effectiveType: "4g", downlink: 0 }), "normal");
  assert.equal(networkTier({ effectiveType: "2g" }, "normal"), "normal");
  assert.equal(networkTier(null, "low"), "low");
});
test("low tier caps capture at 360p and publishes 360p/400k top + one 180p layer; normal unchanged", () => {
  assert.deepEqual(captureResolution("low"), { width: 640, height: 360, frameRate: 24 });
  assert.equal(captureResolution("normal").height, 720);
  const lo = cameraPublishOptions({ VideoPreset }, { codec: "vp8", backup: false }, "low");
  assert.equal(lo.simulcast, true);
  assert.equal(lo.videoEncoding?.maxBitrate, VIDEO_LAYERS.mid.maxBitrate);
  assert.equal(lo.videoEncoding?.maxFramerate, VIDEO_LAYERS.mid.maxFramerate);
  assert.equal(lo.videoSimulcastLayers?.length, 1);
  assert.equal(lo.videoSimulcastLayers?.[0].height, 180);
  const hi = cameraPublishOptions({ VideoPreset }, { codec: "h264", backup: "vp8" });
  assert.equal(hi.videoEncoding?.maxBitrate, VIDEO_LAYERS.top.maxBitrate);
  assert.equal(hi.videoSimulcastLayers?.length, 2);
});
