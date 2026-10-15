// Call sounds — ONE shared ring controller for audio AND video calls (incoming ringtone, outgoing ringback), plus
// busy / connected / hang-up blips. Synthesized (no files: nothing to 404, no CSP media-src, no cache).
//
// Why it was silent before (fixed here):
//  - Outgoing ringback only started when the callee's device acked ("Ringing…"); calls to a phone that wasn't online
//    (push only) never acked → silence the whole time. Now: ringback from the moment you tap call until connect/end.
//  - Incoming ringtone came from a WebSocket event (no user gesture). Its AudioContext was created right then →
//    born "suspended" in Safari/iOS/Firefox/Android WebView, so nothing played. Now one shared context is unlocked on
//    the first tap anywhere in the app (installAudioUnlock) and re-armed whenever it's suspended/interrupted.
//  - iOS puts the context in "interrupted" after getUserMedia (mic/camera prompt at call start); only "suspended"
//    was resumed. Now both are, and the ring is scheduled on the audio clock so it starts the moment it resumes.
//  - Ring cycles were re-armed with setTimeout, which background tabs throttle (≥1 s, then 1/min). Now the whole ring
//    (up to the 45 s deadline) is scheduled on the audio clock in one go.
//  - Volumes were very low (≈ -27 dBFS) and iOS routes WebRTC-era audio to the quiet earpiece. Louder now.
//  - It could still stop early: (1) the deadline compared the server's expiresAt with the phone clock (skew → short
//    ring, see ringUntil in engine.ts); (2) the <audio> fallback was only considered once, 400 ms in, so when iOS /
//    Android audio focus later suspended the context mid-ring (mic prompt, another app) the ring went silent. Now a
//    1 s watchdog re-resumes the context and switches to the looped element whenever Web Audio isn't running, and
//    the element is re-played if the OS pauses it, for as long as the ring state lasts.
//  - Fallback: if Web Audio still isn't running 400 ms after a ring starts, the same tone (rendered to a WAV) plays on
//    the <audio> element primed during an earlier tap.
import { nativePlatform } from "@/lib/native";
import { audioContext, onAudioState, resumeAudio } from "@/lib/audioUnlock";
import { ringAudioElement as primedAudioElement, releaseRingAudio } from "@/lib/calls/ringAudio";

export type RingKind = "incoming" | "outgoing";
type RingState = { kind: RingKind | null; video: boolean; since: number; path: "webaudio" | "element" | "none" | "native"; ctx: string; stalls?: number; revived?: boolean };

const RING_MAX_MS = 60_000;
/** how long a re-arm watches the ring element clock before treating it as stalled-but-"playing" */
export const RING_PROBE_MS = 300;
const PATTERNS: Record<RingKind, { period: number; render: (add: (freqs: number[], at: number, dur: number, vol: number, type?: OscillatorType) => void) => void }> = {
  // incoming: a bright three-note phrase twice, then a pause (2.6 s cycle) — Telegram-like, clearly audible
  incoming: {
    period: 2.6,
    render: (add) => {
      const notes = [784, 988, 1175];
      for (let rep = 0; rep < 2; rep++) notes.forEach((f, i) => add([f, f * 2], rep * 0.5 + i * 0.12, 0.16, 0.16, "triangle"));
    },
  },
  // outgoing: classic ringback 440 + 480 Hz, 1.5 s on / 3 s off (first burst starts immediately)
  outgoing: { period: 4.5, render: (add) => add([440, 480], 0, 1.5, 0.11) },
};

let cur: { stop: () => void; rearm: () => void; state: RingState } | null = null;
let level: AnalyserNode | null = null;

function tone(c: BaseAudioContext, out: AudioNode, freqs: number[], at: number, dur: number, vol: number, type: OscillatorType = "sine") {
  const g = c.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(vol, at + 0.015);
  g.gain.setValueAtTime(vol, at + Math.max(0.02, dur - 0.04));
  g.gain.linearRampToValueAtTime(0, at + dur);
  g.connect(out);
  for (const f of freqs) {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.connect(g);
    o.start(at);
    o.stop(at + dur + 0.02);
  }
}

/** Render N cycles of a pattern to 16-bit WAV (for the <audio> fallback). Pure JS, no OfflineAudioContext needed. */
// The WAV holds the WHOLE ring (RING_MAX_MS of cycles), not one looped cycle: WebKit's <audio loop> leaves a gap at
// every seam, so a one-cycle loop drifted ~20–60 ms per cycle on iPhone vs the sample-accurate Web Audio schedule on
// Android. One long buffer has no seams; its playback position is the cadence clock (seekable to stay aligned).
const WAV_RATE = 16000;
function renderWav(kind: RingKind): string {
  const rate = WAV_RATE;
  const p = PATTERNS[kind];
  const cycles = Math.ceil(RING_MAX_MS / 1000 / p.period);
  const n = Math.round(p.period * cycles * rate);
  const pcm = new Float32Array(n);
  for (let k = 0; k < cycles; k++) p.render((freqs, at0, dur, vol, type = "sine") => {
    const at = at0 + k * p.period;
    const s0 = Math.round(at * rate);
    const len = Math.round(dur * rate);
    for (let i = 0; i < len && s0 + i < n; i++) {
      const t = i / rate;
      const env = Math.min(1, t / 0.015, (dur - t) / 0.04);
      let v = 0;
      for (const f of freqs) {
        const ph = (t * f) % 1;
        v += type === "triangle" ? 1 - 4 * Math.abs(ph - 0.5) : Math.sin(2 * Math.PI * ph);
      }
      pcm[s0 + i] += v * vol * Math.max(0, env);
    }
  });
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  w(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}
const wavCache: Partial<Record<RingKind, string>> = {};

function expose() {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __olRing?: RingState; __olRingLevel?: () => number };
  w.__olRing = cur ? { ...cur.state, ctx: audioContext()?.state ?? "none" } : { kind: null, video: false, since: 0, path: "none", ctx: audioContext()?.state ?? "none" };
  // test/diagnostic hook: the ring element's playback clock (advancing = audibly playing, not just "not paused")
  (w as unknown as { __olRingPos?: () => number }).__olRingPos = () => primedAudioElement()?.currentTime ?? -1;
  // test/diagnostic hook: RMS of what the ring is sending to the speakers right now (0 = silent)
  w.__olRingLevel = () => {
    if (cur?.state.path === "element") {
      const e = primedAudioElement();
      return e && !e.paused ? 1 : 0;
    }
    if (!level || !cur) return 0;
    const a = new Float32Array(level.fftSize);
    level.getFloatTimeDomainData(a);
    let s = 0;
    for (const x of a) s += x * x;
    return Math.sqrt(s / a.length);
  };
}

/** Start the ring for either call type. Same controller for audio and video; replaces whatever was ringing. */
/** The native wrapper can play the outgoing ringback itself; it advertises that with window.__olNativeRingback.
 *  1 = iOS/Android 0.3.12 (no status reports). iOS 0.3.12's player dies right after CallKit activation (Oct 15
 *  13:24 PT, bc2ef950/d307ed56), so on iOS a "1" is NOT trusted: the web ringback plays. 2 = 0.3.13+: the wrapper
 *  reports {playing} via 'openlounge:native-ringback'; the web ring takes over (and tells native to stop) whenever
 *  native has not confirmed playing within NATIVE_CONFIRM_MS or reports it stopped for NATIVE_GAP_MS. */
export const NATIVE_CONFIRM_MS = 4000;
export const NATIVE_GAP_MS = 1500;
export function nativeRingbackMode(): "off" | "trust" | "verified" {
  if (typeof window === "undefined") return "off";
  const v = Number((window as unknown as { __olNativeRingback?: unknown }).__olNativeRingback ?? 0);
  if (!v) return "off";
  if (v >= 2) return "verified";
  return nativePlatform() === "ios" ? "off" : "trust";
}
export const nativeRingback = () => nativeRingbackMode() !== "off";

let nativePlaying = false;
let nativeChangedAt = 0;
if (typeof window !== "undefined")
  window.addEventListener("openlounge:native-ringback", (e) => {
    const playing = !!(e as CustomEvent<{ playing?: boolean }>).detail?.playing;
    if (playing !== nativePlaying) nativeChangedAt = Date.now();
    nativePlaying = playing;
  });

function postNativeRingbackStop() {
  try {
    const w = window as unknown as { __olNativeCalls?: unknown; ReactNativeWebView?: { postMessage(s: string): void }; OpenLoungeNative?: { postMessage?(s: string): void } };
    if (!w.__olNativeCalls) return;
    const m = JSON.stringify({ type: "call:ringbackStop" });
    if (w.ReactNativeWebView) w.ReactNativeWebView.postMessage(m);
    else w.OpenLoungeNative?.postMessage?.(m);
  } catch {
    /* ignore */
  }
}

export function startRing(kind: RingKind, opts: { video?: boolean; untilMs?: number; webOnly?: boolean } = {}) {
  stopTones();
  const mode = kind === "outgoing" && !opts.webOnly ? nativeRingbackMode() : "off";
  if (mode !== "off") {
    const state: RingState = { kind, video: !!opts.video, since: Date.now(), path: "native", ctx: "native" };
    const t0 = Date.now();
    let watch: ReturnType<typeof setInterval> | null = null;
    if (mode === "verified") {
      nativePlaying = false;
      nativeChangedAt = t0;
      watch = setInterval(() => {
        if (cur?.state !== state) return void (watch && clearInterval(watch));
        const now = Date.now();
        const neverStarted = !nativePlaying && nativeChangedAt === t0 && now - t0 > NATIVE_CONFIRM_MS;
        const stopped = !nativePlaying && nativeChangedAt !== t0 && now - nativeChangedAt > NATIVE_GAP_MS;
        if (neverStarted || stopped) {
          if (watch) clearInterval(watch);
          postNativeRingbackStop(); // one owner from here on: no double tone if native recovers later
          startRing(kind, { ...opts, webOnly: true });
          (window as unknown as { __olRingTakeover?: string }).__olRingTakeover = neverStarted ? "never-started" : "stopped";
          expose();
        }
      }, 500);
    }
    cur = { stop: () => { if (watch) clearInterval(watch); }, rearm: () => {}, state };
    expose();
    return;
  }
  const c = resumeAudio() ?? audioContext();
  const state: RingState = { kind, video: !!opts.video, since: Date.now(), path: c ? "webaudio" : "none", ctx: c?.state ?? "none" };
  let alive = true;
  let master: GainNode | null = null;
  let elTimer: ReturnType<typeof setTimeout> | null = null;
  let watchTimer: ReturnType<typeof setInterval> | null = null;
  let vibTimer: ReturnType<typeof setInterval> | null = null;
  let offState: (() => void) | null = null;
  const p = PATTERNS[kind];
  const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
  const ringMs = Math.max(3000, Math.min(RING_MAX_MS, (opts.untilMs ?? Date.now() + RING_MAX_MS) - Date.now()));

  if (c) {
    master = c.createGain();
    master.gain.value = 1;
    level = c.createAnalyser();
    level.fftSize = 1024;
    master.connect(level);
    master.connect(c.destination);
    // schedule the whole ring on the audio clock (immune to background-tab timer throttling; if the context is
    // suspended right now, currentTime is frozen and everything plays from the start once it resumes)
    const t0 = c.currentTime + 0.03;
    const cycles = Math.ceil(ringMs / 1000 / p.period);
    for (let k = 0; k < cycles; k++) p.render((freqs, at, dur, vol, type) => tone(c, master!, freqs, t0 + k * p.period + at, dur, vol, type));
    offState = onAudioState(() => {
      if (alive && c.state !== "running") resumeAudio();
      expose();
    });
  }
  // fallback: Web Audio not running (blocked at start, or suspended later by the OS) → the primed <audio> element
  // (looped WAV). Checked at 400 ms and then every second for the whole ring.
  // iOS app: CallKit activates/reconfigures the AVAudioSession ~0.5–1 s after the ring starts; WKWebView's AudioContext
  // then often reports "running" while producing silence (ring "plays briefly then stops"). There the looped <audio>
  // element — a normal media-session player that survives the handoff — is the primary path, not a fallback.
  const elementFirst = nativePlatform() === "ios";
  let lastPos: number | null = null;
  let stalls = 0;
  let revived = false;
  const restartElement = (e: HTMLAudioElement, align: () => void) => {
    try {
      e.pause();
    } catch {
      /* ignore */
    }
    align(); // resume in step with the original cadence, not mid-gap
    lastPos = null;
    void e.play().catch(() => {});
  };
  const reviveWebAudio = () => {
    if (revived || !master || !c || !alive) return;
    revived = true;
    state.revived = true;
    resumeAudio();
    master.gain.cancelScheduledValues(c.currentTime);
    master.gain.setValueAtTime(master.gain.value, c.currentTime);
    master.gain.linearRampToValueAtTime(1, c.currentTime + 0.01);
    state.ctx = c.state;
    expose();
  };
  const fallback = (force = false) => {
    if (!alive) return;
    if (!force && !elementFirst && audioContext()?.state === "running") return;
    resumeAudio();
    const e = primedAudioElement();
    if (!e) return;
    // cadence position on the ring's own timeline (t0 = startRing), so the element is never a phase-shifted restart
    const phase = () => Math.max(0, (performance.now() - startedAt) / 1000);
    const align = () => {
      try {
        const want = Math.max(0, phase() - 0.03); // Web Audio schedule starts at t0 + 30 ms
        if (Number.isFinite(e.duration) && want < e.duration && Math.abs(e.currentTime - want) > 0.03) e.currentTime = want;
      } catch {
        /* not seekable yet */
      }
    };
    if (state.path === "element") {
      // WKWebView can leave the element "playing" yet silent after getUserMedia / a CallKit session swap, so
      // `paused` alone is not trusted: a clock that has not advanced since the last check is treated as stalled.
      const pos = e.currentTime;
      const stalled = !e.paused && lastPos !== null && Math.abs(pos - lastPos) < 0.05;
      lastPos = pos;
      if (e.paused || stalled || force) {
        if (stalled) state.stalls = ++stalls;
        restartElement(e, align);
        // still stuck after a restart → bring the Web Audio copy (same cadence timeline) back as a safety net
        if (stalls >= 2) reviveWebAudio();
        expose();
      }
      return;
    }
    try {
      const src = (wavCache[kind] ??= renderWav(kind));
      if (e.src !== src) e.src = src;
      e.loop = false; // the WAV already spans the whole ring: no seam gaps
      e.volume = 1;
      align();
      void e.play().then(
        () => {
          if (!alive) return e.pause();
          align();
          state.path = "element";
          if (master && c) {
            // hand over on the audio clock with a 10 ms fade (no click, no double tone)
            master.gain.cancelScheduledValues(c.currentTime);
            master.gain.setValueAtTime(master.gain.value, c.currentTime);
            master.gain.linearRampToValueAtTime(0, c.currentTime + 0.01);
          }
          expose();
        },
        () => {},
      );
    } catch {
      /* ignore */
    }
  };
  // iOS: start the element synchronously in the same task as the ring event (a 0 ms timer added a queue hop + the
  // play() promise before audio; Web Audio covers the first few ms and is faded out on handover)
  if (elementFirst) fallback();
  else elTimer = setTimeout(() => fallback(), 400);
  watchTimer = setInterval(() => fallback(), 1000);
  if (kind === "incoming" && typeof navigator !== "undefined" && "vibrate" in navigator) {
    const buzz = () => {
      try {
        navigator.vibrate([500, 250, 500]);
      } catch {
        /* needs a prior user activation */
      }
    };
    buzz();
    vibTimer = setInterval(buzz, p.period * 1000);
  }
  const stop = () => {
    alive = false;
    if (elTimer) clearTimeout(elTimer);
    if (watchTimer) clearInterval(watchTimer);
    if (vibTimer) clearInterval(vibTimer);
    offState?.();
    try {
      if (master && c) {
        master.gain.cancelScheduledValues(c.currentTime);
        master.gain.setValueAtTime(0, c.currentTime);
        master.disconnect();
      }
      if (kind === "incoming" && "vibrate" in navigator) navigator.vibrate(0);
    } catch {
      /* ignore */
    }
    const e = primedAudioElement();
    if (state.path === "element" && e) {
      e.pause();
      e.loop = false;
    }
    releaseRingAudio();
    level = null;
  };
  // re-arm (CallKit activate, mic granted): restart only if the element is paused or its clock stops advancing,
  // so the idempotent "settle" re-kicks never cut an audibly playing ring
  const rearm = () => {
    if (!alive) return;
    const e = primedAudioElement();
    // browsers: a running Web Audio ring is left alone (no switch to the element just because the mic was granted)
    if (state.path !== "element" && !elementFirst && audioContext()?.state === "running") return;
    if (state.path !== "element" || !e || e.paused) return fallback(true);
    const before = e.currentTime;
    setTimeout(() => {
      if (alive && state.path === "element" && (e.paused || Math.abs(e.currentTime - before) < 0.05)) fallback(true);
    }, RING_PROBE_MS);
  };
  cur = { stop, rearm, state };
  expose();
}

// iOS wrapper: CallKit activating the AVAudioSession interrupts WebKit audio; the wrapper's audioResumeScript calls
// this to resume the context and re-play the ring <audio> loop (it only kicks srcObject elements on its own).
if (typeof window !== "undefined")
  (window as unknown as { __olRingResume?: () => void }).__olRingResume = () => {
    if (!cur) return;
    resumeAudio();
    // the context may claim "running" yet be silent after the session swap: always (re)start the element loop
    cur.rearm();
  };

export function stopTones() {
  const c = cur;
  cur = null;
  c?.stop();
  expose();
}

export const ringing = () => cur?.state.kind ?? null;

/** Re-check the ring after an audio-session change the page caused itself (mic permission granted on iOS). */
export function rearmRing() {
  cur?.rearm();
}

/** call inside a tap so later (non-gesture) tones are allowed to play */
export { unlockAudio as unlockTones } from "@/lib/audioUnlock";

/** Back-compat names (engine): both call types go through startRing. */
export const playRingtone = (opts?: { video?: boolean; untilMs?: number }) => startRing("incoming", opts);
export const playRingback = (opts?: { video?: boolean; untilMs?: number }) => startRing("outgoing", opts);

function blip(seq: [number[], number, number][]) {
  stopTones();
  const c = resumeAudio();
  if (!c) return;
  const t = c.currentTime + 0.02;
  for (const [freqs, at, dur] of seq) tone(c, c.destination, freqs, t + at, dur, 0.09);
}
/** line busy: 3 short beeps */
export const playBusy = () => blip([0, 1, 2].map((i) => [[480, 620], i * 0.5, 0.25] as [number[], number, number]));
export const playConnected = () => blip([[[660], 0, 0.09], [[990], 0.1, 0.12]]);
export const playHangup = () => blip([[[620], 0, 0.12], [[440], 0.14, 0.18]]);
