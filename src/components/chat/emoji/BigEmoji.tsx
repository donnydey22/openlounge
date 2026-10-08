"use client";

// A message that is only 1–3 emoji: big, animated, no bubble (Telegram). Plays once when it first comes into view,
// replays on tap — the tap also fires the full-screen interaction effect (mirrored to the peer by the caller).

import { memo, useState } from "react";
import { AnimatedEmoji } from "./AnimatedEmoji";

const SIZES = [136, 96, 80];

export const BigEmoji = memo(function BigEmoji({
  parts,
  replay,
  onTap,
}: {
  parts: string[];
  /** bumped from outside (the peer tapped it) */
  replay: number;
  onTap?: (emoji: string, at: { x: number; y: number }) => void;
}) {
  const [local, setLocal] = useState(0);
  const size = SIZES[parts.length - 1] ?? 80;
  return (
    <span className="flex items-end" data-testid="big-emoji" data-count={parts.length}>
      {parts.map((e, i) => (
        <span
          key={i}
          data-big-emoji={e}
          className="cursor-pointer"
          onClick={(ev) => {
            const r = ev.currentTarget.getBoundingClientRect();
            setLocal((n) => n + 1);
            onTap?.(e, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
          }}
        >
          <AnimatedEmoji emoji={e} size={size} mode="once" replay={local + replay} />
        </span>
      ))}
    </span>
  );
});

export const bigEmojiSize = (n: number) => SIZES[n - 1] ?? 80;
