// Ring-only audio ownership (calling isolation, REGRESSION_PATTERN_REPORT §5 boundary 4).
// The ring used to borrow the ONE shared <audio> element from audioUnlock.ts that room / join sounds also use, so every
// ring fix also changed room + join audio (and a looped ring left on a non-answering device kept that element busy).
// Now the ring owns its own element. audioUnlock.ts only *calls* our prime hook inside the same user gesture (iOS needs
// a gesture play per element); it never touches this element otherwise, and nothing outside calls/ imports this file.
import { registerUnlockHook, silentWavBytes } from "@/lib/audioUnlock";

let el: HTMLAudioElement | null = null;
let primed = false;
let silentUrl: string | null = null;

function make(): HTMLAudioElement | null {
  if (typeof window === "undefined" || typeof Audio === "undefined") return null;
  try {
    if (!el) {
      el = new Audio();
      el.setAttribute("playsinline", "");
      el.preload = "auto";
    }
    return el;
  } catch {
    return null;
  }
}

/** Gesture-time prime (called synchronously by unlockAudio). Returns true once primed. */
function primeRingElement(): boolean {
  if (primed) return true;
  const e = make();
  if (!e || !e.paused) return primed;
  try {
    e.src = silentUrl ??= URL.createObjectURL(new Blob([silentWavBytes()], { type: "audio/wav" }));
    e.muted = true;
    const p = e.play();
    const ok = () => {
      primed = true;
      e.pause();
      e.muted = false;
    };
    if (p && typeof p.then === "function") p.then(ok, () => {});
    else ok();
  } catch {
    /* no media element */
  }
  return primed;
}
registerUnlockHook(primeRingElement);

/** The ring's element even if priming never succeeded (sticky user activation still allows play()). */
export function ringAudioElement(): HTMLAudioElement | null {
  const e = make();
  if (e) e.muted = false;
  return e;
}

export const ringElementPrimed = () => primed;

/** Release the ring element completely (answered here, answered/declined elsewhere, ended). Idempotent. */
export function releaseRingAudio() {
  if (!el) return;
  try {
    el.loop = false;
    el.pause();
  } catch {
    /* ignore */
  }
}
