import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VideoStallTracker, VIDEO_RESILIENCE, auditVideoSdp, missingResilience, watchVideoResilience } from "../../src/lib/calls/videoResilience";

const SDP = ["v=0", "m=audio 9 UDP/TLS/RTP/SAVPF 111", "a=rtpmap:111 opus/48000/2", "a=rtcp-fb:111 transport-cc",
  "m=video 9 UDP/TLS/RTP/SAVPF 102 103 125", "a=rtpmap:102 H264/90000", "a=rtcp-fb:102 goog-remb", "a=rtcp-fb:102 transport-cc", "a=rtcp-fb:102 ccm fir",
  "a=rtcp-fb:102 nack", "a=rtcp-fb:102 nack pli", "a=rtpmap:103 rtx/90000", "a=fmtp:103 apt=102", "a=rtpmap:125 ulpfec/90000", ""].join("\r\n");

test("audit: NACK / PLI / FIR / RTX / FEC read from the video section only", () => {
  const a = auditVideoSdp(SDP);
  assert.deepEqual(a, { nack: true, pli: true, fir: true, rtx: true, fec: true, transportCc: true });
  assert.deepEqual(missingResilience(a), []);
  assert.deepEqual(missingResilience(auditVideoSdp(SDP.replace(/a=rtcp-fb:102 nack pli\r\n/, "").replace(/a=rtpmap:103 rtx\/90000\r\n/, ""))), ["pli", "rtx"]);
});

test("stall while packets arrive → bigger receiver jitter buffer; smooth for recoverMs → back to default (hysteresis)", () => {
  const t = new VideoStallTracker();
  let at = 0, f = 0, p = 0;
  const step = (frames: number) => { at += 1000; f += frames; p += 50; return t.push({ at, framesDecoded: f, packetsReceived: p }); };
  assert.equal(step(30), undefined);
  assert.equal(step(30), undefined);
  assert.equal(step(0), VIDEO_RESILIENCE.stallJitterTargetMs, "frozen 1 s with packets flowing");
  assert.equal(step(0), undefined, "no repeated sets");
  for (let i = 0; i < 10; i++) assert.equal(step(30), undefined, "not yet recovered");
  assert.equal(step(30), VIDEO_RESILIENCE.baseJitterTargetMs);
  assert.equal(t.stalls, 1);
});

test("no packets (peer camera off / network gone) is not a decoder stall: buffer untouched", () => {
  const t = new VideoStallTracker();
  t.push({ at: 0, framesDecoded: 10, packetsReceived: 100 });
  assert.equal(t.push({ at: 2000, framesDecoded: 10, packetsReceived: 100 }), undefined);
});

test("wrapper is receiver-only: never touches a sender, encodings, codec, bitrate, resolution or framerate", () => {
  const src = readFileSync(new URL("../../src/lib/calls/videoResilience.ts", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  for (const banned of ["RTCRtpSender", "getSenders", "setParameters", "encodings", "maxBitrate", "maxFramerate", "scaleResolutionDownBy", "setCodecPreferences", "applyConstraints"])
    assert.ok(!src.includes(banned), `videoResilience must not use ${banned}`);
});

test("watchVideoResilience sets jitterBufferTarget on a receiver during a stall", async () => {
  let frames = 0, packets = 0, n = 0;
  const receiver: any = { jitterBufferTarget: null, getStats: async () => { n++; packets += 40; if (n < 3) frames += 30; return new Map([["v", { type: "inbound-rtp", kind: "video", framesDecoded: frames, packetsReceived: packets }]]); } };
  const realNow = Date.now; let clock = 0; Date.now = () => (clock += 1000);
  const orig = setInterval; const ticks: Array<() => void> = [];
  (globalThis as any).setInterval = (fn: () => void) => { ticks.push(fn); return 0; };
  try {
    const stop = watchVideoResilience(receiver);
    for (let i = 0; i < 5; i++) { ticks[0](); await new Promise((r) => setImmediate(r)); }
    assert.equal(receiver.jitterBufferTarget, VIDEO_RESILIENCE.stallJitterTargetMs);
    stop();
  } finally { (globalThis as any).setInterval = orig; Date.now = realNow; }
});
