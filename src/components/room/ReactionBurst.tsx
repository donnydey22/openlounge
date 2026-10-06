"use client";

import type { RoomReaction } from "@/lib/types";

/** Full-room reaction burst (center of stage) for reactions whose sender tile isn't visible / as celebration. */
export function ReactionBurst({ reactions }: { reactions: RoomReaction[] }) {
  if (reactions.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden>
      {reactions.map((r, i) => (
        <span
          key={r.id}
          className="reaction-burst absolute text-3xl"
          style={{
            left: `${18 + ((i * 17 + r.createdAt % 40) % 64)}%`,
            bottom: `${12 + (i % 3) * 8}%`,
            animationDelay: `${(i % 4) * 40}ms`,
          }}
        >
          {r.emoji}
        </span>
      ))}
    </div>
  );
}
