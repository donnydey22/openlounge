// One camera/mic startup sequence for every call surface (tracker item 7, Oct 18 2026).
// iOS native-media app, Android WebView and web Safari/Chrome all follow the same ordered steps; only the
// "capture" owner differs (the native app on iOS native-media, the page everywhere else). Waqas's Safari call
// worked because the web path captures inside the user's tap (Answer or Call) and verifies the track is live;
// the iPhone app's outgoing path skipped that verification, so a capture muted by the CallKit session handover
// went out as silence + black. This module is the shared contract; engine/mediasoupSession adopt it step by step
// (the iOS caller fix on fix/ios-caller-capture-handover is the first adopter of the "verify" step).

export type StartupPlatform = "ios-native" | "android-webview" | "web";
export type StartupRole = "caller" | "callee";
export type StartupStep =
  | "unlock-audio" // resume the AudioContext inside the tap
  | "capture-mic" // getUserMedia / native mic grab, inside the tap (permission prompt here)
  | "capture-camera" // video calls: camera preview at once so self-view is never black
  | "connect-transport" // SFU join / send transport
  | "produce" // publish mic (+ camera) tracks
  | "verify-live" // outgoing tracks are live: unmuted, readyState "live", audio energy or video frames seen
  | "rebind-once"; // a dead track found by verify-live → one fresh capture swapped onto the producer

export interface StartupInput {
  platform: StartupPlatform;
  role: StartupRole;
  video: boolean;
  /** iOS native-media calls hold the native capture until answer (loud ringback) */
  deferNativeUntilAnswer?: boolean;
}

/** Ordered steps. Same order everywhere; capture always happens before transport, verify always follows produce. */
export function startupPlan(i: StartupInput): StartupStep[] {
  const steps: StartupStep[] = ["unlock-audio", "capture-mic"];
  if (i.video) steps.push("capture-camera");
  steps.push("connect-transport", "produce", "verify-live", "rebind-once");
  return steps;
}

/** Who captures: the native app (iOS native-media) or the page. */
export const captureOwner = (p: StartupPlatform): "native" | "page" => (p === "ios-native" ? "native" : "page");

export interface TrackSample {
  kind: "audio" | "video";
  readyState: "live" | "ended";
  muted: boolean;
  enabled: boolean;
  /** audio: RMS level 0–1 over the sample window; video: frames encoded/sent in the window */
  level?: number;
  frames?: number;
}

export type LiveVerdict = { ok: true } | { ok: false; reason: "ended" | "muted" | "silent" | "no-frames" };

/**
 * Is an outgoing track actually carrying media? `userMuted` tracks (mic muted in the UI / camera off) are fine.
 * Silence alone is only a failure when the track has produced exactly zero energy for the window (a real room is
 * never digital zero; the broken 2:11 PM call read mic 0 and 0 kbps for 15 s).
 */
export function verifyLive(t: TrackSample, userMuted = false): LiveVerdict {
  if (userMuted || !t.enabled) return { ok: true };
  if (t.readyState === "ended") return { ok: false, reason: "ended" };
  if (t.muted) return { ok: false, reason: "muted" };
  if (t.kind === "audio" && t.level !== undefined && t.level === 0) return { ok: false, reason: "silent" };
  if (t.kind === "video" && t.frames !== undefined && t.frames === 0) return { ok: false, reason: "no-frames" };
  return { ok: true };
}

/** Verify window + bounded retries: same numbers on every platform. */
export const VERIFY_AFTER_MS = 2500;
export const MAX_REBINDS = 2;
