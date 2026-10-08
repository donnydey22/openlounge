// Tiny motion helpers: physically-based springs as CSS linear() easings (WAAPI / CSS), haptics, reduced motion.
// Everything animates transform / opacity only, so it stays on the compositor.

import { haptic as nativeHaptic } from "@/lib/native";
import { prefersReducedMotion } from "./AnimatedEmoji";

export { prefersReducedMotion };

type SpringOpts = { stiffness?: number; damping?: number; mass?: number; velocity?: number };

/** Sample a damped spring 0 → 1. Returns { easing, duration } usable with element.animate(). */
const cache = new Map<string, { easing: string; duration: number }>();
let linearOk: boolean | null = null;
export function spring(o: SpringOpts = {}): { easing: string; duration: number } {
  const { stiffness = 380, damping = 26, mass = 1, velocity = 0 } = o;
  const id = `${stiffness}|${damping}|${mass}|${velocity}`;
  const hit = cache.get(id);
  if (hit) return hit;
  linearOk ??= typeof CSS !== "undefined" && CSS.supports?.("animation-timing-function", "linear(0, 1)");
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const pos = (t: number) => {
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      return 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0 - velocity) / wd) * Math.sin(wd * t));
    }
    return 1 - Math.exp(-w0 * t) * (1 + (w0 - velocity) * t);
  };
  // settle time: |x-1| < 0.001 for good
  let dur = 0;
  for (let t = 0; t < 3; t += 1 / 120) if (Math.abs(pos(t) - 1) > 0.001) dur = t;
  dur = Math.max(0.2, Math.min(dur + 1 / 60, 2));
  const n = 40;
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) pts.push(String(Math.round(pos((dur * i) / n) * 1000) / 1000));
  const out = {
    easing: linearOk ? `linear(${pts.join(", ")})` : zeta < 0.85 ? "cubic-bezier(0.34, 1.56, 0.64, 1)" : "cubic-bezier(0.22, 1, 0.36, 1)",
    duration: Math.round(dur * 1000),
  };
  cache.set(id, out);
  return out;
}

/** Bouncy pop (menus, chips), snappy settle (lift), soft (sheets). */
export const SPRING_POP = { stiffness: 520, damping: 24 };
export const SPRING_SNAPPY = { stiffness: 600, damping: 38 };
export const SPRING_SOFT = { stiffness: 300, damping: 30 };

export function animate(el: Element | null | undefined, frames: Keyframe[], opts: KeyframeAnimationOptions & { spring?: SpringOpts } = {}) {
  if (!el || typeof (el as HTMLElement).animate !== "function") return null;
  const { spring: s, ...rest } = opts;
  if (prefersReducedMotion()) return (el as HTMLElement).animate([frames[frames.length - 1]], { duration: 1, fill: rest.fill });
  const sp = s ? spring(s) : null;
  return (el as HTMLElement).animate(frames, { duration: sp?.duration ?? 240, easing: sp?.easing ?? "cubic-bezier(0.22, 1, 0.36, 1)", ...rest });
}

let lastTick = 0;
/** Native haptic through the app bridge (no-op on the web); throttled so a burst of events = one tick. */
export function haptic(kind: "light" | "medium" | "success" = "light") {
  const now = Date.now();
  if (now - lastTick < 60) return;
  lastTick = now;
  nativeHaptic(kind);
  try {
    if (!(window as unknown as { OpenLoungeNative?: unknown }).OpenLoungeNative && kind !== "light") navigator.vibrate?.(8);
  } catch {
    /* ignore */
  }
}
