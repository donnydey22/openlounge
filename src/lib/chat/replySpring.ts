// Swipe-to-reply physics (WhatsApp-style): the bubble follows the finger 1:1 up to the threshold, then with rubber-band
// resistance; on release it springs home carrying the finger's velocity. Pure functions so they can be unit-tested.

/** Raw horizontal travel (px) that arms the reply. Release past it → reply; drag back below it → cancelled. */
export const REPLY_THRESHOLD = 44;
/** Hard cap on how far the bubble can travel (px). */
export const REPLY_MAX_OFFSET = 88;
/** Resistance past the threshold: each extra px of finger travel moves the bubble this much. */
export const REPLY_RESISTANCE = 0.32;
/** Axis lock distance (px). Below this nothing moves, so taps, long-presses and vertical scrolls stay native. */
export const AXIS_LOCK_PX = 5;
/** Release spring: critically-damped-ish (WhatsApp settles with no visible overshoot in ~250 ms). */
export const RELEASE_SPRING = { stiffness: 800, damping: 56, mass: 1 } // damping ≈ 2·√k → critically damped, ~250 ms;

/** Finger travel → bubble offset (rubber band past the threshold, never negative, capped). */
export function rubberBand(raw: number, threshold = REPLY_THRESHOLD, max = REPLY_MAX_OFFSET, k = REPLY_RESISTANCE) {
  if (!(raw > 0)) return 0;
  if (raw <= threshold) return raw;
  return Math.min(max, threshold + (raw - threshold) * k);
}

/** 0 → 1 progress toward the threshold (drives the reply icon's reveal + scale). */
export const revealProgress = (offset: number, threshold = REPLY_THRESHOLD) => Math.max(0, Math.min(1, offset / threshold));

/** Reply icon transform for a given offset: fades/scales in with the drag, sits a little behind the bubble edge. */
export function iconStyle(offset: number, armed: boolean, threshold = REPLY_THRESHOLD) {
  const p = revealProgress(offset, threshold);
  const scale = armed ? 1 : 0.35 + 0.65 * p;
  return { opacity: p, scale, x: Math.min(offset, threshold) * 0.35 - 6 };
}

/**
 * One semi-implicit Euler step of a damped spring toward 0. Returns the next [position, velocity].
 * dt in seconds; velocity in px/s.
 */
export function springStep(x: number, v: number, dt: number, o = RELEASE_SPRING): [number, number] {
  const a = (-o.stiffness * x - o.damping * v) / o.mass;
  const nv = v + a * dt;
  return [x + nv * dt, nv];
}

/** Simulate the release spring (used by tests to check it settles fast and never overshoots visibly). */
export function simulateRelease(x0: number, v0: number, o = RELEASE_SPRING, hz = 120) {
  let x = x0;
  let v = v0;
  let t = 0;
  let minX = x0;
  const dt = 1 / hz;
  while (t < 2 && (Math.abs(x) > 0.5 || Math.abs(v) > 10)) {
    [x, v] = springStep(x, v, dt, o);
    minX = Math.min(minX, x);
    t += dt;
  }
  return { settleMs: Math.round(t * 1000), overshootPx: Math.max(0, -minX) };
}

/** Velocity (px/s) from the last few pointer samples (newest last), ignoring samples older than 100 ms. */
export function releaseVelocity(samples: { t: number; x: number }[]) {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  const recent = samples.filter((s) => last.t - s.t <= 100);
  const first = recent[0];
  const dt = (last.t - first.t) / 1000;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

/** |dy| must exceed |dx| by this factor before the gesture counts as a vertical scroll (a light swipe's arc is fine). */
export const AXIS_BIAS = 1 / 0.6 // horizontal if dx >= 0.6·|dy|;
/** Flick: a quick swipe past this share of the threshold replies when it is released faster than REPLY_FLICK_VELOCITY. */
export const REPLY_FLICK_RATIO = 0.55;
export const REPLY_FLICK_VELOCITY = 300; // px/s (0.3 px/ms)

/** Direction lock once past the dead zone: rightward and not clearly vertical → "x" (swipe), otherwise "y" (scroll). */
export function lockAxis(dx: number, dy: number): "x" | "y" | null {
  if (Math.abs(dx) <= AXIS_LOCK_PX && Math.abs(dy) <= AXIS_LOCK_PX) return null;
  return dx > 0 && Math.abs(dy) <= dx * AXIS_BIAS ? "x" : "y";
}

/** Does a released swipe reply? Past the threshold, or a fast flick past REPLY_FLICK_RATIO of it. */
export function replyCompletes(dx: number, velocity: number, threshold = REPLY_THRESHOLD) {
  return dx >= threshold || (dx >= threshold * REPLY_FLICK_RATIO && velocity >= REPLY_FLICK_VELOCITY);
}
