"use client";
// Adaptive chat video on a plain <video playsinline> element:
//   • Apple WebKit (iOS/iPadOS any browser, macOS Safari, WKWebView in the iPhone app): native HLS — the OS player
//     does ABR with the hardware decoder. Start variant: master-low.m3u8 (240p first) on slow links / data saver,
//     master.m3u8 (360p first) otherwise. iPhone on iOS 16.4 has no MSE, so native is the only HLS path there anyway.
//   • Everything else with MSE/ManagedMediaSource (Chrome, Edge, Firefox, Android WebView): hls.js light build,
//     loaded on first play only, transmux/parse in a Web Worker; the browser's decoder + compositor present frames
//     (no per-frame JS). Start level low on slow/cellular/Save-Data, capped to the player's on-screen size, data saver
//     caps at 360p, 30 s forward / 10 s back buffer (no OOM on low-end phones).
//   • No HLS at all (old engines, or before the ladder exists): the faststart MP4.
// Only one video plays at a time (claimPlayback), and stats are kept for QA (window.__olVideoStats).
import { networkHint } from "@/lib/dataSaver";

export interface AdaptiveSources {
  hls?: string;
  hlsLow?: string;
  mp4?: string;
}

export interface PlaybackStats {
  id: string;
  engine: "hls.js" | "native-hls" | "mp4";
  startedAt: number;
  /** ms from attach (tap) to the first rendered frame */
  ttffMs: number | null;
  switches: { atMs: number; height: number }[];
  stalls: number;
  stallMs: number;
  startHeight: number | null;
  slow: boolean;
}

declare global {
  interface Window {
    __olVideoStats?: PlaybackStats[];
  }
}

const isAppleWebKit = () => {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iOS = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const safari = /Safari\//.test(ua) && !/(Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg|OPR|Android)\//.test(ua);
  return iOS || safari || /OpenLoungeiOS/i.test(ua);
};
const nativeHls = (v: HTMLVideoElement) => !!v.canPlayType?.("application/vnd.apple.mpegurl");
const hasMse = () =>
  typeof window !== "undefined" &&
  (("MediaSource" in window && typeof (window as unknown as { MediaSource: { isTypeSupported?: (t: string) => boolean } }).MediaSource.isTypeSupported === "function" &&
    (window as unknown as { MediaSource: { isTypeSupported: (t: string) => boolean } }).MediaSource.isTypeSupported('video/mp4; codecs="avc1.4d401f,mp4a.40.2"')) ||
    "ManagedMediaSource" in window);

/**
 * Throughput actually seen on this page for media files (Resource Timing; our media responses send
 * Timing-Allow-Origin so this works through the media cache too). Median of the recent non-cached transfers; null
 * when nothing was measured yet. Small images under-estimate (TCP slow start), which errs on the safe side.
 */
export function measuredBps(): number | null {
  if (typeof performance === "undefined" || !performance.getEntriesByType) return null;
  const xs = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
    .filter((e) => /\/media\/|\/api\/media\/f\//.test(e.name) && e.encodedBodySize > 2000 && e.transferSize > 0 && e.responseEnd - e.requestStart > 20)
    .slice(-6)
    .map((e) => (e.encodedBodySize * 8) / ((e.responseEnd - e.requestStart) / 1000));
  if (!xs.length) return null;
  xs.sort((a, b) => a - b);
  return Math.round(xs[Math.floor(xs.length / 2)]);
}

/** Warm the hls.js chunk (tile pointerdown / hover) so the viewer doesn't wait for it after the tap. */
let hlsP: Promise<unknown> | null = null;
export function prefetchPlayer() {
  if (typeof window === "undefined" || hlsP || isAppleWebKit() || !hasMse()) return;
  hlsP = import("hls.js/light").catch(() => (hlsP = null));
}

// ---------- one video at a time ----------
let current: HTMLVideoElement | null = null;
export const PLAYBACK_EVENT = "openlounge:video-playback";
export function claimPlayback(v: HTMLVideoElement) {
  if (current && current !== v && !current.paused) current.pause();
  current = v;
  window.dispatchEvent(new CustomEvent(PLAYBACK_EVENT, { detail: { active: true } }));
}
export function releasePlayback(v: HTMLVideoElement) {
  if (current !== v) return;
  current = null;
  window.dispatchEvent(new CustomEvent(PLAYBACK_EVENT, { detail: { active: false } }));
}
export const exclusivePlaying = () => !!current && !current.paused;

/** Attach the best source to `video`. Returns a detach function (destroys hls.js, stops stats). */
export function attachAdaptive(video: HTMLVideoElement, src: AdaptiveSources, opts: { id: string; onFatal?: () => void } = { id: "" }) {
  const net = networkHint();
  const seen = measuredBps();
  // best guess of the link: what media loads on this page actually achieved, else the Network Information API
  const estimate = seen ?? (net.estimateBps && (navigator as unknown as { connection?: unknown }).connection ? net.estimateBps : null);
  const slow = net.slow || (estimate !== null && estimate < 1_200_000);
  const stats: PlaybackStats = { id: opts.id, engine: "mp4", startedAt: performance.now(), ttffMs: null, switches: [], stalls: 0, stallMs: 0, startHeight: null, slow };
  (window.__olVideoStats ??= []).push(stats);
  if (window.__olVideoStats.length > 50) window.__olVideoStats.shift();
  let destroyed = false;
  let hls: { destroy(): void } | null = null;
  let stallAt = 0;
  let lastH = 0;
  const now = () => performance.now() - stats.startedAt;
  const onFrame = () => {
    if (stats.ttffMs === null) stats.ttffMs = Math.round(now());
  };
  const onPlaying = () => {
    if (stats.ttffMs === null) {
      // first decoded frame: requestVideoFrameCallback where available (Chromium, Safari 15.4+), else 'playing'
      const rvfc = (video as unknown as { requestVideoFrameCallback?: (cb: () => void) => void }).requestVideoFrameCallback;
      if (rvfc) rvfc.call(video, onFrame);
      else onFrame();
    }
    if (stallAt) {
      stats.stallMs += Math.round(performance.now() - stallAt);
      stallAt = 0;
    }
  };
  const onWaiting = () => {
    if (stats.ttffMs !== null && !video.seeking && !stallAt) {
      stats.stalls++;
      stallAt = performance.now();
    }
  };
  const onResize = () => {
    const h = video.videoHeight;
    if (!h || h === lastH) return;
    if (stats.startHeight === null) stats.startHeight = h;
    else if (stats.engine !== "hls.js") stats.switches.push({ atMs: Math.round(now()), height: h });
    lastH = h;
  };
  const onPlay = () => claimPlayback(video);
  const onPause = () => releasePlayback(video);
  video.addEventListener("playing", onPlaying);
  video.addEventListener("waiting", onWaiting);
  video.addEventListener("resize", onResize);
  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);
  video.addEventListener("ended", onPause);

  const useMp4 = () => {
    if (destroyed || !src.mp4) return opts.onFatal?.();
    stats.engine = "mp4";
    video.src = src.mp4;
  };

  if (src.hls && isAppleWebKit() && nativeHls(video)) {
    stats.engine = "native-hls";
    // native HLS starts on the master's first entry: 240p-first when the link is slow or unknown on cellular
    video.src = (slow || (estimate === null && net.cellular)) && src.hlsLow ? src.hlsLow : src.hls;
  } else if (src.hls && hasMse()) {
    stats.engine = "hls.js";
    void import("hls.js/light")
      .then(({ default: Hls }) => {
        if (destroyed) return;
        if (!Hls.isSupported()) return useMp4();
        const h = new Hls({
          enableWorker: true,
          capLevelToPlayerSize: true,
          // start low on slow / cellular / Save-Data; otherwise let the bandwidth estimate decide from 360p
          startLevel: -1,
          abrEwmaDefaultEstimate: estimate ?? 500_000,
          testBandwidth: false,
          maxBufferLength: 30,
          maxMaxBufferLength: 30,
          backBufferLength: 10,
          maxBufferSize: 30 * 1000 * 1000,
          startFragPrefetch: true,
          lowLatencyMode: false,
          // a couple of quick retries ride out an offline blip without failing the player
          fragLoadPolicy: { default: { maxTimeToFirstByteMs: 10_000, maxLoadTimeMs: 30_000, timeoutRetry: { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 4000 }, errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 } } },
        });
        hls = h;
        h.on(Hls.Events.MANIFEST_PARSED, (_e, d) => {
          const heights = d.levels.map((l) => l.height);
          const pick = (target: number) => {
            let best = 0;
            heights.forEach((ht, i) => (ht <= target && ht >= heights[best] ? (best = i) : null));
            return best;
          };
          // start: the highest rung (≤ 360p) the link sustains with headroom; unknown link → 240p (fastest first
          // frame, the ABR climbs within a few seconds); slow / Save-Data → 240p
          let start = pick(240);
          if (!slow && estimate !== null) {
            d.levels.forEach((l, i) => (l.height <= 360 && l.bitrate * 1.4 <= estimate && l.height >= d.levels[start].height ? (start = i) : null));
          }
          h.startLevel = start;
          if (net.saver) h.autoLevelCapping = pick(360);
        });
        h.on(Hls.Events.LEVEL_SWITCHED, (_e, d) => {
          const ht = h.levels[d.level]?.height ?? 0;
          if (stats.startHeight === null) stats.startHeight = ht;
          else stats.switches.push({ atMs: Math.round(now()), height: ht });
        });
        let mediaRecoveries = 0;
        h.on(Hls.Events.ERROR, (_e, d) => {
          if (!d.fatal) return;
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
            // offline blip / expired link: keep trying from where we are
            setTimeout(() => !destroyed && h.startLoad(), 1500);
          } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 2) h.recoverMediaError();
          else {
            h.destroy();
            hls = null;
            useMp4();
          }
        });
        h.loadSource(src.hls!);
        h.attachMedia(video);
      })
      .catch(useMp4);
  } else useMp4();

  return () => {
    destroyed = true;
    if (stallAt) stats.stallMs += Math.round(performance.now() - stallAt);
    hls?.destroy();
    releasePlayback(video);
    video.removeEventListener("playing", onPlaying);
    video.removeEventListener("waiting", onWaiting);
    video.removeEventListener("resize", onResize);
    video.removeEventListener("play", onPlay);
    video.removeEventListener("pause", onPause);
    video.removeEventListener("ended", onPause);
  };
}
