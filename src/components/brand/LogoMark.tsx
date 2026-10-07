"use client";
// Open Lounge mark: plain 🎙️ emoji on web (app icons keep /public/brand art).
// Animation = one short "voice" sequence (capsule settles, grille levels rise, two arcs ripple out, wordmark reveals),
// ~1.1 s, transform/opacity (+ a one-shot clip-path on the wordmark) only. It plays on mount only when `playOnMount`
// (splash/welcome) and on tap / hover; otherwise it is completely static — no infinite animation, nothing at idle.
// Reduced motion / low-end devices (see lib/device) → static.
import { useCallback, useEffect, useState } from "react";
import { prefersLowMotion } from "@/lib/device";


// Web brand mark = the plain 🎙️ emoji glyph (day-one header mic): no badge, no rotation; the tilt is the glyph's own.
export function LogoMark({ size = 32, title = "Open Lounge", className = "" }: { size?: number; playOnMount?: boolean; title?: string; className?: string }) {
  return (
    <span role="img" aria-label={title} className={`ol-mark inline-block leading-none ${className}`} style={{ fontSize: Math.round(size * 0.8) }}>
      🎙️
    </span>
  );
}

/** Mark + "Open Lounge" wordmark; the whole lockup replays the sequence on tap/hover. */
export function Logo({ size = 28, playOnMount = false, wordmark = true, className = "", textClassName = "" }: { size?: number; playOnMount?: boolean; wordmark?: boolean; className?: string; textClassName?: string }) {
  const [run, setRun] = useState(0);
  const play = useCallback(() => {
    if (prefersLowMotion()) return;
    setRun((n) => n + 1);
  }, []);
  useEffect(() => {
    if (playOnMount) play();
  }, [playOnMount, play]);
  return (
    <span key={run} className={`ol-logo inline-flex items-center gap-2 ${className}`} data-play={run > 0 ? "" : undefined} onPointerDown={play} onMouseEnter={(e) => (matchMedia("(hover: hover) and (pointer: fine)").matches && run === 0 ? play() : void e)}>
      <LogoMark size={size} />
      {wordmark && <span className={`ol-word font-bold tracking-tight whitespace-nowrap ${textClassName}`}>Open Lounge</span>}
    </span>
  );
}
