// FX-081 must-pass: per-stream telemetry (loss, RTT, jitter, bitrate, fps, freezes) every 5 s from both clients + SFU.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TELEMETRY, summarizeStreams } from "../../src/lib/calls/callTelemetry";
import { CallTelemetryStore, sanitizeSample, summarize, TELEMETRY_LIMITS } from "../../server/calls/telemetry";

const rep = (o: Record<string, unknown>[]) => new Map(o.map((x, i) => [String(x.id ?? i), x])) as unknown as RTCStatsReport;

test("client: per-stream loss %, RTT, jitter, kbps, fps, freezes from two samples", () => {
  const prev = new Map();
  const a = rep([
    { id: "cp", type: "candidate-pair", nominated: true, currentRoundTripTime: 0.08 },
    { id: "iv", type: "inbound-rtp", kind: "video", ssrc: 1, bytesReceived: 0, packetsReceived: 100, packetsLost: 0, jitter: 0.01, framesPerSecond: 24, freezeCount: 0, totalFreezesDuration: 0 },
    { id: "oa", type: "outbound-rtp", kind: "audio", ssrc: 2, bytesSent: 0, packetsSent: 100, remoteId: "ra" },
    { id: "ra", type: "remote-inbound-rtp", ssrc: 2, packetsLost: 0, roundTripTime: 0.09, jitter: 0.004 },
  ]);
  summarizeStreams([a], prev, 0);
  const b = rep([
    { id: "cp", type: "candidate-pair", nominated: true, currentRoundTripTime: 0.08 },
    { id: "iv", type: "inbound-rtp", kind: "video", ssrc: 1, bytesReceived: 312_500, packetsReceived: 190, packetsLost: 10, jitter: 0.02, framesPerSecond: 15, freezeCount: 2, totalFreezesDuration: 1.2 },
    { id: "oa", type: "outbound-rtp", kind: "audio", ssrc: 2, bytesSent: 25_000, packetsSent: 350, remoteId: "ra" },
    { id: "ra", type: "remote-inbound-rtp", ssrc: 2, packetsLost: 5, roundTripTime: 0.09, jitter: 0.004 },
  ]);
  const [v, au] = summarizeStreams([b], prev, 5_000);
  assert.deepEqual([v.dir, v.kind, v.lossPct, v.rttMs, v.jitterMs, v.kbps, v.fps, v.freezes, v.freezeMs], ["in", "video", 10, 80, 20, 500, 15, 2, 1200]);
  assert.deepEqual([au.dir, au.kind, au.lossPct, au.rttMs, au.jitterMs, au.kbps], ["out", "audio", 2, 90, 4, 40]);
  assert.equal(TELEMETRY.sampleMs, 5_000);
});

test("server: sanitize rejects junk, bounds streams/rows, summary has loss p95, RTT p95, fps min, freezes, bad windows", () => {
  assert.deepEqual(sanitizeSample("client", "u", null), []);
  assert.deepEqual(sanitizeSample("client", "u", { streams: [{ dir: "in", kind: "screen" }] }), []);
  const many = sanitizeSample("client", "u", { streams: Array.from({ length: 50 }, () => ({ dir: "in", kind: "audio", lossPct: 1 })) });
  assert.equal(many.length, TELEMETRY_LIMITS.streamsPerSample);
  const st = new CallTelemetryStore();
  for (let i = 0; i < 10; i++) st.add("call1", sanitizeSample("client", "keiko", { platform: "android", streams: [{ dir: "in", kind: "video", lossPct: i === 9 ? 30 : 1, rttMs: 100 + i, jitterMs: 10, kbps: 500, fps: i === 9 ? 8 : 24, freezes: i === 9 ? 3 : 1 }] }, i * 5000), i * 5000);
  const [s] = st.summary("call1");
  assert.equal(s.samples, 10); assert.equal(s.lossMax, 30); assert.equal(s.fpsMin, 8); assert.equal(s.freezes, 2); assert.equal(s.badWindows, 1);
  for (let i = 0; i < TELEMETRY_LIMITS.rowsPerCall + 10; i++) st.add("call2", sanitizeSample("sfu", "sfu", { streams: [{ dir: "sfu-out", kind: "audio", lossPct: 0 }] }));
  assert.equal(st.rows("call2").length, TELEMETRY_LIMITS.rowsPerCall);
  assert.equal(summarize([]).length, 0);
});

test("wiring: engine samples every call and stops on teardown; server logs + gateway-only SFU telemetry; schema present", () => {
  const eng = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.match(eng, /this\.startTelemetry\(session\)/);
  assert.ok((eng.match(/this\.stopTelemetry\(\);/g)?.length ?? 0) >= 3, "start + both teardown paths");
  assert.match(eng, /emit\("call:telemetry", payload\)/);
  const idx = readFileSync(new URL("../../server/calls/index.ts", import.meta.url), "utf8");
  assert.match(idx, /socket\.on\("call:telemetry"/);
  assert.match(idx, /mediaGateway\(\)\.handleTelemetry\(socket, data\)/);
  const gw = readFileSync(new URL("../../server/mediasoup/gateway.ts", import.meta.url), "utf8");
  assert.match(gw, /handleTelemetry\(conn: Conn, data: unknown\)[\s\S]{0,120}if \(conn !== this\.conn/);
  const sch = readFileSync(new URL("../../server/wsSchemas.ts", import.meta.url), "utf8");
  assert.match(sch, /"call:telemetry"/);
  const sfu = readFileSync(new URL("../../media-sfu/src/index.mjs", import.meta.url), "utf8");
  assert.match(sfu, /emitGateway\("ms:gateway:telemetry"/);
});
