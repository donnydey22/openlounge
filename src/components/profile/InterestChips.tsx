"use client";

import { INTERESTS, MAX_INTERESTS } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Multi-select interest chips — Open Lounge's own labels, Clubhouse-like UX.
 * Editable mode shows an "8 of 12" counter; at MAX_INTERESTS unselected chips are disabled
 * (selected ones can still be tapped to deselect).
 */
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

  // Only known labels count (the server drops anything else); guard against >12 legacy data.
  const count = selected.filter((x) => (INTERESTS as readonly string[]).includes(x)).length;
  const atMax = count >= MAX_INTERESTS;
  const over = count - MAX_INTERESTS;

  const chips = (
    <div className={cn("flex flex-wrap gap-2", readOnly && className)}>
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
        const disabled = !on && atMax;
        return (
          <button
            key={label}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => {
              if (!onChange) return;
              if (on) onChange(selected.filter((x) => x !== label));
              else if (!atMax) onChange([...selected, label]);
            }}
            className={cn(
              "rounded-full border px-3.5 py-1.5 text-[13px] transition active:scale-[0.98]",
              on
                ? "border-emerald-500/70 bg-emerald-500/15 font-medium text-emerald-300"
                : disabled
                  ? "cursor-not-allowed border-white/10 text-zinc-300 opacity-40 active:scale-100"
                  : "border-white/10 text-zinc-300 hover:border-white/25",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );

  if (readOnly) return chips;

  return (
    <div className={className}>
      <div className="mb-3 flex items-center gap-3 text-xs" aria-live="polite">
        {atMax && (
          <span className="text-zinc-500">
            {over > 0 ? `You can pick up to ${MAX_INTERESTS} — remove ${over}` : `You can pick up to ${MAX_INTERESTS}`}
          </span>
        )}
        <span className={cn("ml-auto font-medium tabular-nums", atMax ? "text-emerald-400" : "text-zinc-500")}>
          {count} of {MAX_INTERESTS}
        </span>
      </div>
      {chips}
    </div>
  );
}
