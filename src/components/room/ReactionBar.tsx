"use client";

import { ROOM_REACTIONS } from "@/lib/types";
import { cn } from "@/lib/utils";

export function ReactionBar({
  open,
  onPick,
}: {
  open: boolean;
  onPick: (emoji: string) => void;
}) {
  if (!open) return null;
  return (
    <div className="mb-2 flex items-center justify-center gap-1 rounded-full border border-white/10 bg-zinc-900/95 p-1.5 shadow-xl backdrop-blur">
      {ROOM_REACTIONS.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => onPick(e)}
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-full text-xl transition hover:scale-110 hover:bg-white/10 active:scale-95",
          )}
          aria-label={`Send ${e}`}
        >
          {e}
        </button>
      ))}
    </div>
  );
}
