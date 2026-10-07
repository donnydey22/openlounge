"use client";

import { cn } from "@/lib/utils";

export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange(v: boolean): void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn("relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-40", on ? "bg-emerald-500" : "bg-zinc-700")}
    >
      <span className={cn("absolute top-0.5 h-5 w-5 rounded-full bg-[#fff] shadow transition-all", on ? "left-[22px]" : "left-0.5")} />
    </button>
  );
}
