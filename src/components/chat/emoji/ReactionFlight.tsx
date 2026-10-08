"use client";

// The "reaction effect": the picked emoji appears big where it was picked, plays its animation with a particle burst
// around it, then shrinks and flies into its chip on the bubble, which pops. transform/opacity only.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatedEmoji } from "./AnimatedEmoji";
import { burst, warmEffect } from "./effects";
import { animate, prefersReducedMotion, spring, SPRING_POP } from "./motion";

export type Flight = { id: number; emoji: string; messageId: string; from: { x: number; y: number } | null };
const SIZE = 112;

export function ReactionFlight({ f, onLand }: { f: Flight; onLand: (f: Flight) => void }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    warmEffect(f.emoji);
    const node = el.current;
    const chip = () => document.querySelector<HTMLElement>(`[data-chip="${CSS.escape(f.emoji)}"][data-mid="${CSS.escape(f.messageId)}"]`);
    const bubble = document.querySelector<HTMLElement>(`[data-mid-bubble="${CSS.escape(f.messageId)}"]`);
    const br = bubble?.getBoundingClientRect();
    // start: where it was picked, nudged so the big emoji sits above the bubble (not under the finger)
    const vw = window.innerWidth;
    const sx = Math.max(SIZE / 2 + 8, Math.min(vw - SIZE / 2 - 8, f.from?.x ?? (br ? br.left + br.width / 2 : vw / 2)));
    const sy = Math.max(SIZE / 2 + 60, (br ? br.top : f.from?.y ?? 200) - 18);
    if (!node || prefersReducedMotion()) {
      onLand(f);
      return;
    }
    node.style.transform = `translate3d(${sx - SIZE / 2}px, ${sy - SIZE / 2}px, 0)`;
    const inA = animate(node.firstElementChild, [{ transform: "scale(0.25)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { spring: SPRING_POP, fill: "both" });
    const t1 = setTimeout(() => burst(sx, sy, f.emoji, false), 90);
    const t2 = setTimeout(() => {
      const c = chip()?.getBoundingClientRect();
      const tx = c ? c.left + 4 + 10 : sx;
      const ty = c ? c.top + c.height / 2 : sy + 40;
      const s = 20 / SIZE;
      const sp = spring({ stiffness: 260, damping: 26 });
      const a = node.animate(
        [
          { transform: `translate3d(${sx - SIZE / 2}px, ${sy - SIZE / 2}px, 0) scale(1)` },
          { transform: `translate3d(${tx - SIZE / 2}px, ${ty - SIZE / 2}px, 0) scale(${s})` },
        ],
        { duration: Math.min(520, sp.duration), easing: "cubic-bezier(0.5, 0, 0.2, 1)", fill: "forwards" },
      );
      a.onfinish = () => onLand(f);
    }, 950);
    return () => {
      inA?.cancel();
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(
    <div ref={el} className="pointer-events-none fixed top-0 left-0 z-[96] will-change-transform" style={{ width: SIZE, height: SIZE, transformOrigin: "center" }} data-testid="reaction-flight">
      <div className="h-full w-full">
        <AnimatedEmoji emoji={f.emoji} size={SIZE} mode="once" replay={1} />
      </div>
    </div>,
    document.body,
  );
}
