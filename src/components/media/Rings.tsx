"use client";
import { cn } from "@/lib/utils";

/** Circular progress (uploads / downloads). `value` 0..1, or undefined = indeterminate spinner. */
export function ProgressRing({ value, size = 44, stroke = 3, className, children }: { value?: number; size?: number; stroke?: number; className?: string; children?: React.ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = value === undefined ? 0.25 : Math.max(0.02, Math.min(1, value));
  return (
    <span className={cn("relative inline-flex items-center justify-center", className)} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn("absolute inset-0 -rotate-90", value === undefined && "animate-spin motion-reduce:animate-none")} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
          style={{ transition: value === undefined ? undefined : "stroke-dashoffset 200ms linear" }}
        />
      </svg>
      <span className="relative inline-flex items-center justify-center">{children}</span>
    </span>
  );
}

/** Self-destruct countdown ring (fraction of the timer left) — Telegram's flame-ring badge. */
export function CountdownRing({ left, size = 16, stroke = 2 }: { left: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.3} strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, left)))} />
    </svg>
  );
}
