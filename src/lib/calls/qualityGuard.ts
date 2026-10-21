// Bandwidth/quality-triggered UDP → TCP fallback for the direct (mediasoup, UDP-first) call path.
// The engine samples the mediasoup transports' getStats() every QUALITY_SAMPLE_MS and feeds the cumulative counters
// here. A call is moved to the durable LiveKit path (ICE/TCP, TURN-TCP / TURN-TLS 443) when the UDP path has been
// clearly degraded for a sustained window — not only when ICE hard-fails.

export const QUALITY_SAMPLE_MS = 2_000;
/** Consecutive bad samples (≈ 8 s) before switching: long enough to ignore a single burst, short enough to rescue the call. */
export const QUALITY_BAD_SAMPLES = 4;
export const QUALITY_LIMITS = {
  /** Inbound audio loss above this (after Opus FEC/RED) is audibly broken. */
  maxLossPercent: 12,
  /** Round-trip above this makes conversation unusable and usually means a bufferbloated / throttled UDP path. */
  maxRttMs: 700,
  /** Send-side bandwidth estimate below this cannot carry even voice with headroom (Opus 24–48 kbps + overhead). */
  minOutgoingKbps: 40,
  /** Remote is unmuted but nothing arrived for the whole sample: the UDP path is black-holed. */
  minInboundAudioKbps: 1,
} as const;

export interface QualityCounters {
  timestampMs: number;
  /** cumulative inbound-rtp audio */
  audioPacketsReceived?: number;
  audioPacketsLost?: number;
  audioBytesReceived?: number;
  /** selected candidate-pair */
  currentRoundTripTimeSeconds?: number;
  availableOutgoingBitrate?: number;
  /** current inbound audio jitter reported by WebRTC (seconds), where available */
  audioJitterSeconds?: number;
}

export type QualityVerdict = { bad: boolean; reasons: string[]; lossPercent: number | null; rttMs: number | null; outKbps: number | null; inAudioKbps: number | null; jitterMs: number | null };

export function judgeQuality(prev: QualityCounters | null, cur: QualityCounters, opts: { remoteMuted?: boolean; maxJitterMs?: number } = {}): QualityVerdict {
  const reasons: string[] = [];
  let lossPercent: number | null = null;
  let inAudioKbps: number | null = null;
  if (prev) {
    const secs = Math.max(0.001, (cur.timestampMs - prev.timestampMs) / 1000);
    const rx = Math.max(0, (cur.audioPacketsReceived ?? 0) - (prev.audioPacketsReceived ?? 0));
    const lost = Math.max(0, (cur.audioPacketsLost ?? 0) - (prev.audioPacketsLost ?? 0));
    if (rx + lost >= 10) lossPercent = (lost / (rx + lost)) * 100;
    if (cur.audioBytesReceived !== undefined && prev.audioBytesReceived !== undefined)
      inAudioKbps = (Math.max(0, cur.audioBytesReceived - prev.audioBytesReceived) * 8) / secs / 1000;
  }
  const rttMs = typeof cur.currentRoundTripTimeSeconds === "number" ? cur.currentRoundTripTimeSeconds * 1000 : null;
  const outKbps = typeof cur.availableOutgoingBitrate === "number" ? cur.availableOutgoingBitrate / 1000 : null;
  const jitterMs = typeof cur.audioJitterSeconds === "number" ? cur.audioJitterSeconds * 1000 : null;
  if (lossPercent !== null && lossPercent > QUALITY_LIMITS.maxLossPercent) reasons.push("loss");
  if (rttMs !== null && rttMs > QUALITY_LIMITS.maxRttMs) reasons.push("rtt");
  if (opts.maxJitterMs !== undefined && jitterMs !== null && jitterMs > opts.maxJitterMs) reasons.push("jitter");
  if (outKbps !== null && outKbps > 0 && outKbps < QUALITY_LIMITS.minOutgoingKbps) reasons.push("bandwidth");
  // Opus DTX still sends ~comfort-noise frames every 400 ms, so 0 bytes for a whole sample while unmuted = black hole.
  if (!opts.remoteMuted && inAudioKbps !== null && inAudioKbps < QUALITY_LIMITS.minInboundAudioKbps && prev?.audioBytesReceived) reasons.push("no-audio");
  return { bad: reasons.length > 0, reasons, lossPercent, rttMs, outKbps, inAudioKbps, jitterMs };
}

/** Rolling guard: returns the triggering verdict once QUALITY_BAD_SAMPLES consecutive samples were bad. */
export class QualityGuard {
  private prev: QualityCounters | null = null;
  private streak = 0;
  constructor(private readonly need = QUALITY_BAD_SAMPLES) {}
  push(cur: QualityCounters, opts: { remoteMuted?: boolean; maxJitterMs?: number } = {}): QualityVerdict | null {
    const v = judgeQuality(this.prev, cur, opts);
    this.prev = cur;
    this.streak = v.bad ? this.streak + 1 : 0;
    return this.streak >= this.need ? v : null;
  }
  reset() {
    this.prev = null;
    this.streak = 0;
  }
}

/** Fold an RTCStatsReport (from both mediasoup transports) into the counters the guard needs. */
export function countersFromStats(reports: Iterable<RTCStatsReport | Map<string, Record<string, unknown>>>, now = Date.now()): QualityCounters {
  const c: QualityCounters = { timestampMs: now, audioPacketsReceived: 0, audioPacketsLost: 0, audioBytesReceived: 0 };
  for (const report of reports) {
    (report as Map<string, Record<string, unknown>>).forEach((s) => {
      if (s.type === "inbound-rtp" && (s.kind === "audio" || s.mediaType === "audio")) {
        c.audioPacketsReceived! += Number(s.packetsReceived ?? 0);
        c.audioPacketsLost! += Math.max(0, Number(s.packetsLost ?? 0));
        c.audioBytesReceived! += Number(s.bytesReceived ?? 0);
        if (typeof s.jitter === "number") c.audioJitterSeconds = Math.max(c.audioJitterSeconds ?? 0, s.jitter);
      } else if (s.type === "candidate-pair" && (s.nominated || s.selected) && s.state === "succeeded") {
        if (typeof s.currentRoundTripTime === "number") c.currentRoundTripTimeSeconds = Math.max(c.currentRoundTripTimeSeconds ?? 0, s.currentRoundTripTime);
        // Native controller stats carry their own direction. Only its send transport's estimate can cap this
        // device's camera; untagged browser reports retain the established aggregate behavior.
        if (typeof s.availableOutgoingBitrate === "number" && (s.__olTransportDirection === undefined || s.__olTransportDirection === "send"))
          c.availableOutgoingBitrate = Math.min(c.availableOutgoingBitrate ?? Infinity, s.availableOutgoingBitrate);
      }
    });
  }
  return c;
}
