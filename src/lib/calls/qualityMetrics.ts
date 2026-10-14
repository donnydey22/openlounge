// Pure WebRTC quality math used by the review harness and future on-device call diagnostics.
// It accepts cumulative RTP counters, so callers never need to expose call IDs, media URLs, or user data.

export interface VideoRtpCounters {
  timestampMs: number;
  bytesSent: number;
  framesEncoded: number;
  packetsSent?: number;
  packetsLost?: number;
  width?: number;
  height?: number;
  /** WebRTC exposes RTT in seconds. */
  roundTripTimeSeconds?: number;
  /** WebRTC exposes jitter in seconds. */
  jitterSeconds?: number;
}

export interface VideoQualityMeasurement {
  width: number | null;
  height: number | null;
  fps: number;
  bitrateKbps: number;
  packetLossPercent: number | null;
  roundTripMs: number | null;
  jitterMs: number | null;
}

function rounded(value: number, digits = 1) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/**
 * Calculate a capture/send interval from two standard RTP counter snapshots. Returning null for unavailable loss/RTT
 * avoids presenting a made-up network result on browsers that do not expose remote-inbound statistics.
 */
export function measureVideoQuality(before: VideoRtpCounters, after: VideoRtpCounters): VideoQualityMeasurement {
  const elapsedSeconds = Math.max(0.001, (after.timestampMs - before.timestampMs) / 1_000);
  const bytes = Math.max(0, after.bytesSent - before.bytesSent);
  const frames = Math.max(0, after.framesEncoded - before.framesEncoded);
  const sent = Math.max(0, (after.packetsSent ?? 0) - (before.packetsSent ?? 0));
  const lost = Math.max(0, (after.packetsLost ?? 0) - (before.packetsLost ?? 0));
  const lossDenominator = sent + lost;
  return {
    width: after.width ?? null,
    height: after.height ?? null,
    fps: rounded(frames / elapsedSeconds),
    bitrateKbps: rounded((bytes * 8) / elapsedSeconds / 1_000),
    packetLossPercent: lossDenominator > 0 ? rounded((lost / lossDenominator) * 100, 2) : null,
    roundTripMs: typeof after.roundTripTimeSeconds === "number" ? rounded(after.roundTripTimeSeconds * 1_000) : null,
    jitterMs: typeof after.jitterSeconds === "number" ? rounded(after.jitterSeconds * 1_000) : null,
  };
}
