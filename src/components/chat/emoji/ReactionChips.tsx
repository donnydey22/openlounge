"use client";

// Reaction chips under a bubble: one per emoji with its count; mine highlighted; tap toggles (Telegram: tapping a
// chip you didn't pick switches your reaction to it). New chips pop in with a spring, counts bump on change.

import { memo, useEffect, useMemo, useRef } from "react";
import type { DmReaction } from "@/lib/types";
import { AnimatedEmoji } from "./AnimatedEmoji";
import { SPRING_POP, animate } from "./motion";
import { cn } from "@/lib/utils";

export type ChipAgg = { emoji: string; count: number; mine: boolean; first: number };

export function aggregate(reactions: DmReaction[] | undefined, meId: string | undefined): ChipAgg[] {
  if (!reactions?.length) return [];
  const m = new Map<string, ChipAgg>();
  for (const r of reactions) {
    const c = m.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false, first: r.at };
    c.count++;
    c.mine ||= r.userId === meId;
    c.first = Math.min(c.first, r.at);
    m.set(r.emoji, c);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.first - b.first);
}

const Chip = memo(function Chip({ c, arriving, play, onToggle, messageId, live }: { c: ChipAgg; arriving: boolean; play: number; onToggle: (emoji: string, el: HTMLElement) => void; messageId: string; live: boolean }) {
  const el = useRef<HTMLButtonElement>(null);
  const born = useRef(true);
  const prevCount = useRef(c.count);
  // pop on first appearance (live only — not for history: those render before the row is marked live)
  useEffect(() => {
    if (born.current) {
      born.current = false;
      if (live) animate(el.current, [{ transform: "scale(0.2)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { spring: SPRING_POP });
    }
  }, []);
  useEffect(() => {
    if (prevCount.current !== c.count) {
      prevCount.current = c.count;
      animate(el.current?.querySelector("[data-count]"), [{ transform: "translateY(-6px) scale(1.25)", opacity: 0.4 }, { transform: "none", opacity: 1 }], { spring: SPRING_POP });
    }
  }, [c.count]);
  useEffect(() => {
    if (play) animate(el.current, [{ transform: "scale(0.6)" }, { transform: "scale(1.18)" }, { transform: "scale(1)" }], { duration: 420, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });
  }, [play]);
  return (
    <button
      ref={el}
      type="button"
      data-chip={c.emoji}
      data-mine={c.mine ? "1" : "0"}
      data-mid={messageId}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(c.emoji, e.currentTarget);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      aria-pressed={c.mine}
      aria-label={`${c.emoji} ${c.count}${c.mine ? ", you reacted" : ""}`}
      className={cn(
        "flex h-[26px] items-center gap-1 rounded-full pr-2 pl-1 text-[12.5px] font-semibold tabular-nums shadow-sm ring-1 transition-colors duration-150 active:scale-95",
        c.mine ? "bg-emerald-500 text-on-accent ring-emerald-300/40" : "bg-zinc-800/95 text-zinc-200 ring-white/10 hover:bg-zinc-700",
      )}
    >
      <span className={cn("transition-opacity duration-100", arriving && "opacity-0")}>
        <AnimatedEmoji emoji={c.emoji} size={20} mode={play ? "once" : "static"} replay={play} autoPlay={false} />
      </span>
      <span data-count className="inline-block min-w-[0.5rem]">
        {c.count}
      </span>
    </button>
  );
});

export const ReactionChips = memo(function ReactionChips({
  reactions,
  meId,
  messageId,
  mine,
  arriving,
  playKey,
  onToggle,
}: {
  reactions: DmReaction[] | undefined;
  meId: string | undefined;
  messageId: string;
  /** align with my bubble (right) or theirs (left) */
  mine: boolean;
  /** emoji whose flight hasn't landed yet (its icon stays hidden) */
  arriving: string | null;
  /** `${emoji}|${nonce}`: replay that chip's animation (after a flight lands) */
  playKey: string | null;
  onToggle: (emoji: string, el: HTMLElement) => void;
}) {
  const chips = useMemo(() => aggregate(reactions, meId), [reactions, meId]);
  // chips that appear after the row has been on screen a moment are "live" (pop in); history renders still
  const since = useRef(typeof performance !== "undefined" ? performance.now() : 0);
  const live = typeof performance !== "undefined" && performance.now() - since.current > 400;
  if (!chips.length) return null;
  const [playEmoji, playNonce] = playKey ? playKey.split("|") : [null, "0"];
  return (
    <div className={cn("relative z-[1] -mt-1.5 flex flex-wrap gap-1", mine ? "justify-end pr-1" : "justify-start pl-9")} data-testid="dm-reactions">
      {chips.map((c) => (
        <Chip key={c.emoji} c={c} arriving={arriving === c.emoji} play={playEmoji === c.emoji ? Number(playNonce) : 0} onToggle={onToggle} messageId={messageId} live={live} />
      ))}
    </div>
  );
});
