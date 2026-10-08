// Call sounds, synthesized with Web Audio (no audio files to download, nothing to cache-bust):
// ringtone (incoming), ringback (outgoing, once the callee's device rings), busy, connect and hang-up blips.
// Volumes are low and everything stops instantly. Vibration rides along on devices that support it.

let ctx: AudioContext | null = null;
let stopCurrent: (() => void) | null = null;

function ac(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const AC: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** call inside a tap so later (non-gesture) tones are allowed to play */
export function unlockTones() {
  ac();
}

function tone(c: AudioContext, out: AudioNode, freqs: number[], at: number, dur: number, vol: number, type: OscillatorType = "sine") {
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

function loop(pattern: (c: AudioContext, out: AudioNode, t0: number) => number, vibrate?: number[]) {
  stopTones();
  const c = ac();
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let master: GainNode | null = null;
  if (c) {
    master = c.createGain();
    master.gain.value = 1;
    master.connect(c.destination);
  }
  const run = () => {
    if (!alive) return;
    let period = 3000;
    if (c && master) period = pattern(c, master, c.currentTime + 0.02) * 1000;
    try {
      if (vibrate && "vibrate" in navigator) navigator.vibrate(vibrate);
    } catch {
      /* not allowed without a gesture */
    }
    timer = setTimeout(run, period);
  };
  run();
  stopCurrent = () => {
    alive = false;
    if (timer) clearTimeout(timer);
    try {
      if (master && c) {
        master.gain.cancelScheduledValues(c.currentTime);
        master.gain.setValueAtTime(0, c.currentTime);
        master.disconnect();
      }
      if (vibrate && "vibrate" in navigator) navigator.vibrate(0);
    } catch {
      /* ignore */
    }
  };
}

export function stopTones() {
  stopCurrent?.();
  stopCurrent = null;
}

/** incoming: a soft three-note marimba-ish phrase twice, then a pause (≈ 2.6 s cycle) + vibration */
export function playRingtone() {
  loop(
    (c, out, t) => {
      const notes = [784, 988, 1175];
      for (let rep = 0; rep < 2; rep++) notes.forEach((f, i) => tone(c, out, [f, f * 2], t + rep * 0.5 + i * 0.12, 0.16, 0.07, "triangle"));
      return 2.6;
    },
    [500, 250, 500],
  );
}

/** outgoing "Ringing…": classic ringback (440 + 480 Hz, 1.5 s on / 3 s off), quiet */
export function playRingback() {
  loop((c, out, t) => {
    tone(c, out, [440, 480], t, 1.5, 0.045);
    return 4.5;
  });
}

/** line busy: 3 short beeps */
export function playBusy() {
  stopTones();
  const c = ac();
  if (!c) return;
  const t = c.currentTime + 0.02;
  for (let i = 0; i < 3; i++) tone(c, c.destination, [480, 620], t + i * 0.5, 0.25, 0.05);
}

export function playConnected() {
  stopTones();
  const c = ac();
  if (!c) return;
  const t = c.currentTime + 0.02;
  tone(c, c.destination, [660], t, 0.09, 0.05);
  tone(c, c.destination, [990], t + 0.1, 0.12, 0.05);
}

export function playHangup() {
  stopTones();
  const c = ac();
  if (!c) return;
  const t = c.currentTime + 0.02;
  tone(c, c.destination, [620], t, 0.12, 0.05);
  tone(c, c.destination, [440], t + 0.14, 0.18, 0.05);
}
