"use client";
// Open Lounge mark: squircle badge + mic glyph (master geometry: /public/brand/mark.svg, 1024 grid).
// Animation = one short "voice" sequence (capsule settles, grille levels rise, two arcs ripple out, wordmark reveals),
// ~1.1 s, transform/opacity (+ a one-shot clip-path on the wordmark) only. It plays on mount only when `playOnMount`
// (splash/welcome) and on tap / hover; otherwise it is completely static — no infinite animation, nothing at idle.
// Reduced motion / low-end devices (see lib/device) → static.
import { useCallback, useEffect, useId, useState } from "react";
import { prefersLowMotion } from "@/lib/device";

const SQUIRCLE = "M1024 512L1024 684L1022 739L1020 778L1017 810L1013 837L1008 861L1002 881L995 900L988 917L979 932L969 945L958 958L945 969L932 979L917 988L900 995L881 1002L861 1008L837 1013L810 1017L778 1020L739 1022L684 1024L512 1024L340 1024L285 1022L246 1020L214 1017L187 1013L163 1008L143 1002L124 995L107 988L92 979L79 969L66 958L55 945L45 932L36 917L29 900L22 881L16 861L11 837L7 810L4 778L2 739L0 684L0 512L0 340L2 285L4 246L7 214L11 187L16 163L22 143L29 124L36 107L45 92L55 79L66 66L79 55L92 45L107 36L124 29L143 22L163 16L187 11L214 7L246 4L285 2L340 0L512 0L684 0L739 2L778 4L810 7L837 11L861 16L881 22L900 29L917 36L932 45L945 55L958 66L969 79L979 92L988 107L995 124L1002 143L1008 163L1013 187L1017 214L1020 246L1022 285L1024 340Z";

export function LogoMark({ size = 32, playOnMount = false, title = "Open Lounge", className = "" }: { size?: number; playOnMount?: boolean; title?: string; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} role="img" aria-label={title} className={`ol-mark ${className}`} data-small={size <= 32 ? "" : undefined}>
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#34D399" /><stop offset="1" stopColor="#059669" /></linearGradient>
        <linearGradient id={`h${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".22" /><stop offset=".5" stopColor="#fff" stopOpacity="0" /></linearGradient>
      </defs>
      <path d={SQUIRCLE} fill={`url(#g${id})`} />
      <path d={SQUIRCLE} fill={`url(#h${id})`} />
      <g transform="translate(0 -8)">
        <g className="ol-arcs" fill="none" stroke="#fff" strokeWidth="40" strokeLinecap="round">
          <path className="ol-arc ol-arc1" d="M236 280a320 320 0 0 0 0 304M788 280a320 320 0 0 1 0 304" />
          <path className="ol-arc ol-arc2" d="M160 228a420 420 0 0 0 0 408M864 228a420 420 0 0 1 0 408" />
        </g>
        <rect className="ol-capsule" x="400" y="200" width="224" height="384" rx="112" fill="#fff" />
        {size > 32 && (
          <g fill="#10B981" opacity=".9">
            <rect className="ol-lvl ol-lvl3" x="456" y="296" width="112" height="24" rx="12" />
            <rect className="ol-lvl ol-lvl2" x="456" y="360" width="112" height="24" rx="12" />
            <rect className="ol-lvl ol-lvl1" x="456" y="424" width="112" height="24" rx="12" />
          </g>
        )}
        <path d="M304 480v16a208 208 0 0 0 416 0v-16M512 712v104M400 824h224" fill="none" stroke="#fff" strokeWidth="64" strokeLinecap="round" />
      </g>
    </svg>
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
