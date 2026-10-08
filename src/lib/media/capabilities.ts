"use client";
// Feature detection for media (every engine back to iOS 15 Safari / Android 7 WebView). Never throws.

/** Recorder mime in preference order: Opus in WebM (Chrome, Edge, Firefox, Android), AAC in MP4 (Safari / iOS), Ogg. */
export function recorderMime(): string | null {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") return null;
  const prefs = ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm", "audio/aac"];
  for (const m of prefs) {
    try {
      if (MediaRecorder.isTypeSupported?.(m)) return m;
    } catch {}
  }
  return ""; // MediaRecorder exists but can't tell: let it pick its default
}

export function canRecordVoice() {
  return typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && recorderMime() !== null && window.isSecureContext !== false;
}

export const prefersReducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** data saver / 2G: don't autoplay videos or prefetch full-size photos */
export function saveData() {
  const c = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !!c?.saveData || c?.effectiveType === "2g" || c?.effectiveType === "slow-2g";
}

export const hasIntersectionObserver = () => typeof window !== "undefined" && "IntersectionObserver" in window;

/** Optional native-wrapper hooks (next phone build). Feature-detected; the web fallbacks always work. */
export interface MediaNativeBridge {
  /** hand a signed https URL to the OS: Android DownloadManager / iOS Quick Look */
  openFile?(url: string, name: string, mime: string): void;
  /** Android FLAG_SECURE while a self-destructing photo/video is open (blocks screenshots + recents preview) */
  setSecureScreen?(on: boolean): void;
  getPlatform?(): string;
}
export function mediaNative(): MediaNativeBridge | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown as { OpenLoungeNative?: MediaNativeBridge }).OpenLoungeNative as MediaNativeBridge) ?? null;
}
export function inNativeApp() {
  return typeof navigator !== "undefined" && (/OpenLounge(Android|iOS)/i.test(navigator.userAgent) || !!mediaNative()?.getPlatform);
}
