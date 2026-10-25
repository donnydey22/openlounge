// FX-080 3-layer simulcast (Donny, Oct 24 2026 8:51 PM MST: WhatsApp-level quality, "simulcast and telemetry first").
// The camera publishes low / mid / high encodings so the SFU can switch a receiver's layer (consumer preferred layers)
// without renegotiating and without touching the sender. Every layer keeps the FX-079 frame-rate floor (>= 15 fps).
// Gated: off until the rollout flag is set (window.__olSimulcast = true, or NEXT_PUBLIC_OL_SIMULCAST=1), so the
// proven single-encoding path is byte-identical until Donny flips it.
import { ANTI_FREEZE, antiFreezeFps } from "./antiFreeze";

export type SimulcastLayer = { rid: "q" | "h" | "f"; scaleResolutionDownBy: number; maxBitrate: number; maxFramerate: number };

/** low (~180p) / mid (~360p) / high (~720p), ascending order as mediasoup expects (spatial layer 0 = lowest). */
export const SIMULCAST_LAYERS: readonly SimulcastLayer[] = [
  { rid: "q", scaleResolutionDownBy: 4, maxBitrate: 150_000, maxFramerate: 15 },
  { rid: "h", scaleResolutionDownBy: 2, maxBitrate: 400_000, maxFramerate: 24 },
  { rid: "f", scaleResolutionDownBy: 1, maxBitrate: 1_200_000, maxFramerate: 30 },
] as const;

/** Temporal layers inside every spatial layer: the SFU can also drop to 1/2 or 1/4 frame rate without a keyframe. */
export const SIMULCAST_SCALABILITY = "L1T3";

// FX-082: the server's per-user grant for the current call (media.callq.simulcast). Only ever turns simulcast ON for
// an allowlisted test account; absent grant = exactly the previous flag logic.
let serverGrant = false;
export function setSimulcastGrant(media: { callq?: { simulcast?: boolean } } | null | undefined): void {
  serverGrant = media?.callq?.simulcast === true;
}

export function simulcastEnabled(): boolean {
  if (serverGrant) return true;
  try {
    const w = typeof window === "undefined" ? undefined : (window as unknown as { __olSimulcast?: boolean });
    if (w?.__olSimulcast === true) return true;
    if (w?.__olSimulcast === false) return false;
  } catch { /* ignore */ }
  return typeof process !== "undefined" && process.env?.NEXT_PUBLIC_OL_SIMULCAST === "1";
}

/** Camera producer encodings: 3 layers when enabled, undefined (= the proven single encoding) otherwise. */
export function cameraEncodings(enabled = simulcastEnabled()): RTCRtpEncodingParameters[] | undefined {
  if (!enabled) return undefined;
  return SIMULCAST_LAYERS.map((l) => ({ rid: l.rid, scaleResolutionDownBy: l.scaleResolutionDownBy, maxBitrate: l.maxBitrate, maxFramerate: antiFreezeFps(l.maxFramerate), scalabilityMode: SIMULCAST_SCALABILITY, active: true }) as RTCRtpEncodingParameters);
}

/**
 * The netAdapt ladder on a simulcast sender: instead of shrinking one encoding, keep each layer's own resolution and
 * switch layers on from the bottom while they fit the rung's video budget. The low layer is always on (never a
 * frozen/black picture) and never below the FX-079 fps floor.
 */
export function simulcastLadderPatch(encodings: RTCRtpEncodingParameters[], step: { videoBps: number; videoFps: number }) {
  let used = 0;
  encodings.forEach((e, i) => {
    const layer = SIMULCAST_LAYERS[Math.min(i, SIMULCAST_LAYERS.length - 1)];
    const fits = i === 0 || used + layer.maxBitrate <= step.videoBps;
    e.active = fits;
    e.maxBitrate = i === 0 ? Math.max(60_000, Math.min(layer.maxBitrate, step.videoBps)) : layer.maxBitrate;
    e.maxFramerate = Math.max(ANTI_FREEZE.minFps, Math.min(layer.maxFramerate, antiFreezeFps(step.videoFps) || layer.maxFramerate));
    e.scaleResolutionDownBy = layer.scaleResolutionDownBy;
    if (fits) used += e.maxBitrate;
  });
  return encodings;
}
