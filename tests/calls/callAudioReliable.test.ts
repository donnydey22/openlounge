import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { QualityGuard, QUALITY_BAD_SAMPLES, countersFromStats, judgeQuality } from "../../src/lib/calls/qualityGuard";

const src = (p: string) => readFileSync(p, "utf8");

test("quality guard: healthy UDP never falls back", () => {
  const g = new QualityGuard();
  for (let i = 0; i < 20; i++)
    assert.equal(g.push({ timestampMs: i * 2000, audioPacketsReceived: i * 100, audioPacketsLost: i, audioBytesReceived: i * 8000, currentRoundTripTimeSeconds: 0.08, availableOutgoingBitrate: 900_000 }), null);
});

test("quality guard: sustained 25% loss triggers TCP fallback after N samples, a single burst does not", () => {
  const g = new QualityGuard();
  let rx = 0, lost = 0, bytes = 0, fired = -1;
  for (let i = 0; i < 10; i++) {
    rx += 75; lost += 25; bytes += 6000;
    if (g.push({ timestampMs: i * 2000, audioPacketsReceived: rx, audioPacketsLost: lost, audioBytesReceived: bytes }) && fired < 0) fired = i;
  }
  assert.equal(fired, QUALITY_BAD_SAMPLES); // first sample has no delta
  const h = new QualityGuard();
  h.push({ timestampMs: 0, audioPacketsReceived: 0, audioPacketsLost: 0 });
  h.push({ timestampMs: 2000, audioPacketsReceived: 50, audioPacketsLost: 50 });
  assert.equal(h.push({ timestampMs: 4000, audioPacketsReceived: 150, audioPacketsLost: 50 }), null);
});

test("quality guard: bandwidth collapse, high RTT and black-holed audio are each bad; remote mute is not", () => {
  const p = { timestampMs: 0, audioBytesReceived: 1000, audioPacketsReceived: 10, audioPacketsLost: 0 };
  assert.deepEqual(judgeQuality(p, { ...p, timestampMs: 2000, audioBytesReceived: 9000, availableOutgoingBitrate: 25_000 }).reasons, ["bandwidth"]);
  assert.deepEqual(judgeQuality(p, { ...p, timestampMs: 2000, audioBytesReceived: 9000, currentRoundTripTimeSeconds: 1.2 }).reasons, ["rtt"]);
  assert.deepEqual(judgeQuality(p, { ...p, timestampMs: 2000 }).reasons, ["no-audio"]);
  assert.equal(judgeQuality(p, { ...p, timestampMs: 2000 }, { remoteMuted: true }).bad, false);
});

test("countersFromStats folds inbound audio and the selected pair", () => {
  const r = new Map<string, Record<string, unknown>>([
    ["a", { type: "inbound-rtp", kind: "audio", packetsReceived: 90, packetsLost: 10, bytesReceived: 5000 }],
    ["v", { type: "inbound-rtp", kind: "video", packetsReceived: 900, packetsLost: 0, bytesReceived: 9e5 }],
    ["p", { type: "candidate-pair", nominated: true, state: "succeeded", currentRoundTripTime: 0.3, availableOutgoingBitrate: 300_000 }],
  ]);
  const c = countersFromStats([r], 1);
  assert.equal(c.audioPacketsReceived, 90);
  assert.equal(c.audioPacketsLost, 10);
  assert.equal(c.currentRoundTripTimeSeconds, 0.3);
  assert.equal(c.availableOutgoingBitrate, 300_000);
});

test("native paired media uses only its send transport's outbound estimate", () => {
  const r = new Map<string, Record<string, unknown>>([
    ["send", { type: "candidate-pair", nominated: true, state: "succeeded", __olTransportDirection: "send", availableOutgoingBitrate: 1_500_000 }],
    ["recv", { type: "candidate-pair", nominated: true, state: "succeeded", __olTransportDirection: "recv", availableOutgoingBitrate: 300_000 }],
  ]);
  assert.equal(countersFromStats([r], 1).availableOutgoingBitrate, 1_500_000);
  assert.match(src("src/lib/calls/qualityGuard.ts"), /__olTransportDirection === undefined \|\| s\.__olTransportDirection === "send"/);
});

test("engine wires the quality guard to the LiveKit TCP fallback and keeps hard-failure fallback", () => {
  const e = src("src/lib/calls/engine.ts");
  assert.match(e, /startQualityGuard\(session\)/);
  assert.match(e, /ms-quality-fallback[\s\S]{0,120}requestTcpFallback/);
  assert.match(e, /state === "failed"\) return void this\.requestTcpFallback/);
});

test("phones publish the raw AEC/NS/AGC mic on the LiveKit path too; desktop keeps the loudness gain", () => {
  assert.match(src("src/lib/calls/engine.ts"), /useRawDirectCallMicrophone\(\{[^}]*\}\) \? null : audioContext\(\)/);
  assert.match(src("src/lib/calls/voiceProcessing.ts"), /CALL_MIC_GAIN = 2\.0/);
});

test("remote call audio is explicitly played and replayed after a native audio-session swap", () => {
  const e = src("src/lib/calls/engine.ts");
  assert.match(e, /if \(el\.paused\) void el\.play\(\)/);
  assert.match(e, /openlounge:native-audio-resume/);
});

test("iOS ring: element loop is primary and the CallKit resume hook force re-arms it", () => {
  const t = src("src/lib/calls/tones.ts");
  assert.match(t, /elementFirst = nativePlatform\(\) === "ios"/);
  assert.match(t, /__olRingResume = \(\) =>[\s\S]{0,200}cur\.rearm\(\)/);
});

test("incoming card: idempotent accept/decline, optimistic Connecting…, >=64px targets, no tap delay, retry on blip", () => {
  const o = src("src/components/calls/CallOverlay.tsx");
  assert.match(o, /if \(acted\.current\) return;/);
  assert.match(o, /Connecting…/);
  assert.match(o, /touchAction: "manipulation"/);
  assert.doesNotMatch(o.slice(o.indexOf("function Incoming"), o.indexOf("{replies &&")), /h-12 w-12/);
  assert.match(src("src/lib/calls/engine.ts"), /tap Accept to try again/);
});
