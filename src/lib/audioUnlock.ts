// Autoplay unlock that works in desktop/mobile browsers, the Android WebView APK and iOS
// WKWebView. Call unlockAudio() synchronously inside a user tap (join room, Let's Go, mic
// toggle, "Tap to enable audio", call/accept): it resumes the ONE shared AudioContext, plays a
// silent buffer (the iOS-required "gesture play"), primes a reusable <audio> element, and asks
// the active LiveKit room to start playback.
// installAudioUnlock() (mounted once by CallProvider) does the same on the first tap/key anywhere,
// and again whenever the context gets suspended/interrupted (iOS after getUserMedia, a phone call,
// or the app going to the background), so incoming-call ringtones can play without a fresh tap.

type StartableRoom = { startAudio(): Promise<void>; canPlaybackAudio: boolean };

let ctx: AudioContext | null = null;
let activeRoom: StartableRoom | null = null;
let el: HTMLAudioElement | null = null;
let elPrimed = false;
const listeners = new Set<() => void>();

/** The hook registers the connected LiveKit room so taps anywhere can unlock it. */
export function setActiveAudioRoom(room: StartableRoom | null) {
  activeRoom = room;
}

/** The shared AudioContext (created on first use; may still be suspended until a gesture). */
export function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const AC: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!ctx || ctx.state === "closed") {
      ctx = new AC();
      ctx.addEventListener?.("statechange", () => listeners.forEach((f) => f()));
    }
    return ctx;
  } catch {
    return null;
  }
}

/** iOS reports "interrupted" (not "suspended") after getUserMedia / a phone call: resume both. */
export function resumeAudio() {
  const c = audioContext();
  if (c && c.state !== "running" && c.state !== "closed") void c.resume().catch(() => {});
  return c;
}

export const audioRunning = () => ctx?.state === "running";

export function onAudioState(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** A media element that was played once inside a gesture: iOS/Android WebView then let it play other sources later. */
export function primedAudioElement(): HTMLAudioElement | null {
  return elPrimed ? el : null;
}

/** The shared element even if priming never succeeded: with sticky user activation (Chrome / Firefox / Safari after
 *  any tap on the page) play() is still allowed, so the ring fallback must try it rather than give up silently. */
export function ringAudioElement(): HTMLAudioElement | null {
  if (elPrimed) return el;
  if (typeof window === "undefined" || typeof Audio === "undefined") return null;
  try {
    if (!el) {
      el = new Audio();
      el.setAttribute("playsinline", "");
      el.preload = "auto";
    }
    el.muted = false;
    return el;
  } catch {
    return null;
  }
}

// 0.1 s of real (zero) samples: the old header-only WAV had an EMPTY data chunk, which Firefox (and some WebKit builds)
// refuse to decode ("could not be decoded"), so play() rejected, the element was never primed and the ring's
// <audio> fallback had nothing to play whenever Web Audio wasn't running → silent ring.
export function silentWavBytes(ms = 100, rate = 8000): Uint8Array<ArrayBuffer> {
  const n = Math.round((rate * ms) / 1000);
  const b = new Uint8Array(44 + n * 2);
  const v = new DataView(b.buffer);
  const w = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
  return b;
}
// a blob: URL, not data: — the CSP's media-src allows 'self' blob: only (data: was refused on WebKit / Firefox)
let silentUrl: string | null = null;
const silentWav = () =>
  (silentUrl ??= URL.createObjectURL(new Blob([silentWavBytes()], { type: "audio/wav" })));

export function unlockAudio(): void {
  if (typeof window === "undefined") return;
  try {
    const c = resumeAudio();
    if (c) {
      // one-sample silent buffer: satisfies iOS's "must start audio inside a gesture" rule
      const buf = c.createBuffer(1, 1, 22050);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      src.start(0);
    }
  } catch {
    /* no Web Audio — LiveKit's startAudio below still runs */
  }
  try {
    if (!el) {
      el = new Audio();
      el.setAttribute("playsinline", "");
      el.preload = "auto";
    }
    if (!elPrimed && el.paused) {
      el.src = silentWav();
      el.muted = true;
      const p = el.play();
      const ok = () => {
        elPrimed = true;
        el?.pause();
        if (el) el.muted = false;
      };
      if (p && typeof p.then === "function") p.then(ok, () => {});
      else ok();
    }
  } catch {
    /* no media element */
  }
  void activeRoom?.startAudio().catch(() => {});
}

let installed = false;
/** Unlock on the first interaction anywhere, and re-arm whenever the context stops running. */
export function installAudioUnlock() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const evs = ["pointerdown", "touchend", "keydown", "click"] as const;
  const onGesture = () => {
    unlockAudio();
    if (audioRunning() && elPrimed) disarm();
  };
  let armed = false;
  const arm = () => {
    if (armed) return;
    armed = true;
    for (const e of evs) window.addEventListener(e, onGesture, { capture: true, passive: true });
  };
  const disarm = () => {
    if (!armed) return;
    armed = false;
    for (const e of evs) window.removeEventListener(e, onGesture, { capture: true });
  };
  arm();
  onAudioState(() => {
    if (!audioRunning()) arm();
  });
  // coming back to the app: try a gesture-less resume (allowed once the page has had a user activation)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ctx && ctx.state !== "running") resumeAudio();
  });
}
