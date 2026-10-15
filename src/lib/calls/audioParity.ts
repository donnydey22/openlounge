// One audio contract for every engine (Chromium, Firefox, WebKit/Safari, Edge = Chromium, native WebViews).
// Derived from audioPolicy so there is exactly one source of truth; used by the parity test and by diagnostics.
import { CALL_AUDIO_CONSTRAINTS, OPUS_VOICE_CODEC_OPTIONS } from "./audioPolicy";

/** Opus fmtp exactly as mediasoup emits it for OPUS_VOICE_CODEC_OPTIONS. */
export function opusFmtp(o = OPUS_VOICE_CODEC_OPTIONS): Record<string, number> {
  return {
    useinbandfec: o.opusFec ? 1 : 0,
    usedtx: o.opusDtx ? 1 : 0,
    stereo: o.opusStereo ? 1 : 0,
    maxplaybackrate: o.opusMaxPlaybackRate,
    maxaveragebitrate: o.opusMaxAverageBitrate,
  };
}

/** Jitter buffer: every engine uses its adaptive default (no per-browser override = identical policy). */
export const CALL_JITTER_BUFFER_TARGET_MS: number | null = null;

export const AUDIO_CONTRACT = {
  constraints: CALL_AUDIO_CONSTRAINTS,
  codec: { mimeType: "audio/opus", clockRate: 48_000, channels: 2 /* RTP opus is always signalled /2 */ },
  fmtp: opusFmtp(),
  ptime: OPUS_VOICE_CODEC_OPTIONS.opusPtime,
  jitterBufferTargetMs: CALL_JITTER_BUFFER_TARGET_MS,
} as const;

/** Parse an fmtp line ("minptime=10;useinbandfec=1") into numbers. */
export function parseFmtp(line: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kv of (line ?? "").split(";")) {
    const [k, v] = kv.trim().split("=");
    if (k && v !== undefined) out[k] = Number(v);
  }
  return out;
}

/** Fields of the contract that differ from a negotiated fmtp (empty = parity). */
export function fmtpMismatches(line: string | undefined, want = opusFmtp()): string[] {
  const got = parseFmtp(line);
  return Object.entries(want).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${k}: want ${v} got ${got[k]}`);
}
