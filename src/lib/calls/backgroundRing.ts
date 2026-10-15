// Keep an audible incoming-call ring going when the tab is hidden / the device is locked, as far as
// browsers allow. See docs/calls-background-ring.md for the honest limits.
//
// Strategy (no edits to tones.ts / engine.ts ring scheduling — those are owned by fix/ring-silent):
//  1. Keep trying to resume the shared AudioContext and re-play the primed <audio> element.
//  2. Ask the service worker to show a persistent call notification (requireInteraction, renotify,
//     vibrate, Accept / Decline) and re-show it every few seconds until stop.
//  3. presence:visible is already false for a hidden tab (realtime.appVisible), so the server also
//     sends the push — the SW turns that into the same insistent notification.
import { resumeAudio, audioContext } from "@/lib/audioUnlock";
import { ringAudioElement } from "@/lib/calls/ringAudio";
import { appVisible } from "@/lib/realtime";

export type BackgroundRingInfo = {
  callId: string;
  name: string;
  video: boolean;
  expiresAt: number;
};

const SW_START = "openlounge:call-ring-start";
const SW_STOP = "openlounge:call-ring-stop";
const SW_TICK_MS = 3000;

let active: BackgroundRingInfo | null = null;
let audioTimer: ReturnType<typeof setInterval> | null = null;
let swTimer: ReturnType<typeof setInterval> | null = null;

function postSw(msg: Record<string, unknown>) {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const ctrl = navigator.serviceWorker.controller;
  if (ctrl) {
    ctrl.postMessage(msg);
    return;
  }
  void navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage(msg)).catch(() => {});
}

function keepAudioAlive() {
  resumeAudio();
  const c = audioContext();
  if (c && c.state !== "running") void c.resume().catch(() => {});
  const e = ringAudioElement();
  if (e && e.paused && e.loop) void e.play().catch(() => {});
}

function showSw(info: BackgroundRingInfo) {
  postSw({
    type: SW_START,
    callId: info.callId,
    title: info.name,
    body: info.video ? "Incoming video call" : "Incoming audio call",
    url: `/call/${encodeURIComponent(info.callId)}`,
    acceptUrl: `/call/${encodeURIComponent(info.callId)}?accept=1`,
    expiresAt: info.expiresAt,
    video: info.video,
  });
}

/** Start (or refresh) the background ring aids for an incoming call. Safe to call repeatedly. */
export function startBackgroundRing(info: BackgroundRingInfo) {
  if (typeof window === "undefined") return;
  active = info;
  keepAudioAlive();
  showSw(info);
  if (!audioTimer) audioTimer = setInterval(keepAudioAlive, 1000);
  if (!swTimer) swTimer = setInterval(() => {
    if (!active) return;
    if (Date.now() > active.expiresAt) {
      stopBackgroundRing(active.callId);
      return;
    }
    // Re-show while the tab is still hidden; a visible tab has the in-page ring.
    if (!appVisible()) showSw(active);
  }, SW_TICK_MS);
}

export function stopBackgroundRing(callId?: string) {
  if (callId && active && active.callId !== callId) return;
  const id = active?.callId;
  active = null;
  if (audioTimer) {
    clearInterval(audioTimer);
    audioTimer = null;
  }
  if (swTimer) {
    clearInterval(swTimer);
    swTimer = null;
  }
  if (id) postSw({ type: SW_STOP, callId: id });
  else postSw({ type: SW_STOP });
}

/** True when the page should lean on SW + audio keepalive (hidden tab or native App Lock). */
export function needsBackgroundRing(): boolean {
  return !appVisible();
}

/** Test hooks. */
export const __bgRing = {
  SW_START,
  SW_STOP,
  SW_TICK_MS,
  getActive: () => active,
  reset() {
    active = null;
    if (audioTimer) clearInterval(audioTimer);
    if (swTimer) clearInterval(swTimer);
    audioTimer = null;
    swTimer = null;
  },
};
