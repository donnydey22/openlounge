import assert from "node:assert/strict";
import test from "node:test";
import { measureVideoQuality } from "../../src/lib/calls/qualityMetrics";

test("measures portrait 720p/30 call quality from standard RTP counter deltas", () => {
  const measurement = measureVideoQuality(
    { timestampMs: 10_000, bytesSent: 1_000, framesEncoded: 5, packetsSent: 10, packetsLost: 0 },
    {
      timestampMs: 15_000,
      bytesSent: 751_000,
      framesEncoded: 155,
      packetsSent: 510,
      packetsLost: 5,
      width: 720,
      height: 1280,
      roundTripTimeSeconds: 0.12,
      jitterSeconds: 0.006,
    },
  );
  assert.deepEqual(measurement, {
    width: 720,
    height: 1280,
    fps: 30,
    bitrateKbps: 1_200,
    packetLossPercent: 0.99,
    roundTripMs: 120,
    jitterMs: 6,
  });
});

test("measures bounded low-network 360p/24 output and reports unavailable loss honestly", () => {
  const measurement = measureVideoQuality(
    { timestampMs: 1_000, bytesSent: 0, framesEncoded: 0 },
    { timestampMs: 6_000, bytesSent: 250_000, framesEncoded: 120, width: 360, height: 640 },
  );
  assert.deepEqual(measurement, {
    width: 360,
    height: 640,
    fps: 24,
    bitrateKbps: 400,
    packetLossPercent: null,
    roundTripMs: null,
    jitterMs: null,
  });
});

test("never reports negative rates when browser counters reset during a reconnect", () => {
  const measurement = measureVideoQuality(
    { timestampMs: 5_000, bytesSent: 500_000, framesEncoded: 120, packetsSent: 500, packetsLost: 3 },
    { timestampMs: 6_000, bytesSent: 100, framesEncoded: 1, packetsSent: 1, packetsLost: 0 },
  );
  assert.equal(measurement.fps, 0);
  assert.equal(measurement.bitrateKbps, 0);
  assert.equal(measurement.packetLossPercent, null);
});
