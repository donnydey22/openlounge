"use client";

import { INTERESTS } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Multi-select interest chips — Open Lounge's own labels, Clubhouse-like UX. */
export function InterestChips({
  selected,
  onChange,
  readOnly,
  className,
}: {
  selected: string[];
  onChange?: (next: string[]) => void;
  readOnly?: boolean;
  className?: string;
}) {
  const list = readOnly ? selected : [...INTERESTS];
  if (readOnly && selected.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {list.map((label) => {
        const on = selected.includes(label);
        if (readOnly) {
          return (
            <span
              key={label}
              className="rounded-full border border-white/10 bg-zinc-900/80 px-3.5 py-1.5 text-[13px] text-zinc-200"
            >
              {label}
            </span>
          );
        }
        return (
          <button
            key={label}
            type="button"
            onClick={() => {
              if (!onChange) return;
              onChange(on ? selected.filter((x) => x !== label) : [...selected, label]);
            }}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-[13px] transition active:scale-[0.98]",
              on
                ? "border-emerald-500/70 bg-emerald-500/15 font-medium text-emerald-300"
                : "border-white/10 text-zinc-300 hover:border-white/25",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
