/**
 * Mediasoup camera simulcast (3 layers: ~180p / ~360p / ~720p) and receiver layer choice by rendered tile size.
 * Pure helpers so they can be unit-tested without a browser.
 */
export type SimulcastEnv = { ua: string };

export type SimulcastEncoding = { rid?: string; scaleResolutionDownBy: number; maxBitrate?: number; maxFramerate?: number; scalabilityMode?: string };

/** Low → high, as mediasoup-client expects (it reverses for Firefox internally). */
/**
 * Layer count follows the captured frame: Chromium only sends as many simulcast streams as the source resolution
 * allows (a 640x480 phone sensor frame silently loses the full-res layer when 3 are requested). Short side >= 540 → 3
 * layers (~180/360/720p); >= 240 → 2 layers (half + full); smaller → single layer (null).
 */
export function simulcastEncodings(env: SimulcastEnv, frame?: { width?: number; height?: number }): SimulcastEncoding[] | null {
  const ua = env.ua || "";
  // Chromium-family (Chrome, Edge, Android WebView, Samsung) supports scalabilityMode on sendEncodings; Firefox and
  // WebKit accept plain simulcast encodings but can reject or ignore scalabilityMode, so it is only set on Chromium.
  const webkitOnly = /AppleWebKit/.test(ua) && !/Chrome|Chromium|CriOS|Edg|Android/.test(ua);
  const firefox = /Firefox|FxiOS/.test(ua);
  const chromium = !webkitOnly && !firefox;
  const mode = chromium ? { scalabilityMode: "L1T3" } : {};
  const short = frame?.width && frame?.height ? Math.min(frame.width, frame.height) : 720;
  if (short < 240) return null;
  if (short < 540) return [
    { scaleResolutionDownBy: 2, maxBitrate: 250_000, maxFramerate: 20, ...mode },
    { scaleResolutionDownBy: 1, maxFramerate: 30, ...mode },
  ];
  return [
    { scaleResolutionDownBy: 4, maxBitrate: 150_000, maxFramerate: 15, ...mode },
    { scaleResolutionDownBy: 2, maxBitrate: 500_000, maxFramerate: 30, ...mode },
    // Top layer uncapped: congestion control can use the camera's full healthy bitrate (the #41 lesson: no fixed ceiling).
    { scaleResolutionDownBy: 1, maxFramerate: 30, ...mode },
  ];
}

/** Spatial layer by the tile's short side in device px (DPR capped at 2): <=320 → 0 (180p, PiP/thumbnail), <=400 → 1 (360p), else 2 (720p, stage). */
export function layerForTile(cssWidth: number, cssHeight: number, dpr = 1, maxLayer = 2): number {
  if (!(cssWidth > 0) || !(cssHeight > 0)) return Math.min(0, maxLayer);
  const px = Math.min(cssWidth, cssHeight) * Math.max(1, Math.min(dpr, 2));
  const layer = px <= 320 ? 0 : px <= 400 ? 1 : 2;
  return Math.max(0, Math.min(layer, maxLayer));
}

/**
 * Highest layer the network allows. The SFU already drops layers on its own bandwidth estimate; this is the viewer-side
 * cap: heavy loss (>15%) → 180p, a low-tier link or sustained loss (>6%) → 360p. Thresholds sit above the few percent
 * of apparent loss that layer switches and BWE ramp-up produce on a clean link (measured on loopback).
 */
export function maxLayerForNetwork(tier: "low" | "normal", lossRatio = 0): number {
  if (lossRatio > 0.15) return 0;
  if (tier === "low" || lossRatio > 0.06) return 1;
  return 2;
}

/** True when the consumer's RTP parameters describe a multi-spatial-layer stream (mediasoup reports L3T3/S3T3). */
export function isSimulcastConsumer(rtpParameters: unknown): boolean {
  const enc = (rtpParameters as { encodings?: Array<{ scalabilityMode?: string }> } | null)?.encodings?.[0];
  return typeof enc?.scalabilityMode === "string" && /^[LS][2-9]/.test(enc.scalabilityMode);
}
