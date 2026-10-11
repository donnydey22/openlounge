"use client";

// Telegram-style message action overlay: long-press / right-click a message → the screen dims and blurs, the message
// lifts (a snapshot of the bubble, scaled up a touch), the quick-reaction bar springs up above it and the action menu
// below it. "+" expands the bar into the full animated picker. Everything is transform/opacity; the snapshot is a
// DOM clone, so the live list never re-renders while the overlay is open.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import { AnimatedEmoji } from "./AnimatedEmoji";
import { EmojiPicker } from "./EmojiPicker";
import { QUICK_REACTIONS } from "@/lib/emoji/assets";
import { safeInsets, visibleViewport } from "@/lib/emoji/fit";
import { SPRING_POP, SPRING_SNAPPY, animate, haptic, prefersReducedMotion } from "./motion";
import { cn } from "@/lib/utils";

export type MessageAction = { key: string; label: string; icon: ReactNode; danger?: boolean; onSelect: () => void };

export type OverlayTarget = {
  /** the bubble element to lift */
  el: HTMLElement;
  mine: boolean;
  /** emoji I already reacted with on this message (highlighted in the bar) */
  myReaction: string | null;
  /** small header line in the menu (full date/time) */
  meta?: string;
  /** reactions allowed (not for unsent / blocked) */
  canReact: boolean;
};

const BAR_H = 52;
const GAP = 8;
const EDGE = 10;
const ITEM_H = 44;
/** quick-reaction button width (tap target ≥ 36 px) and the "+" button */
const QR_W = 38;
const MORE_W = 36;

export function MessageActionOverlay({
  target,
  actions,
  onReact,
  onClose,
}: {
  target: OverlayTarget;
  actions: MessageAction[];
  /** emoji picked; `from` = viewport centre of the picked emoji (the flight starts there) */
  onReact: (emoji: string, from: { x: number; y: number }) => void;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const lift = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const [geo] = useState(() => layout(target, actions.length));

  // lift: hide the original while its snapshot floats (restored on close)
  useLayoutEffect(() => {
    const el = target.el;
    const clone = el.cloneNode(true) as HTMLElement;
    // the snapshot must not be mistaken for the real message (queries by id, tests)
    for (const n of [clone, ...clone.querySelectorAll("*")]) for (const at of ["data-testid", "data-mid-bubble", "data-mid", "data-chip", "data-big-emoji", "id"]) n.removeAttribute(at);
    clone.setAttribute("aria-hidden", "true");
    clone.style.margin = "0";
    clone.style.width = `${geo.rect.width}px`;
    clone.style.animation = "none";
    lift.current?.appendChild(clone);
    // horizontal scrollers (album carousel) don't clone their scroll position: copy it so the snapshot shows the same page
    const scrollers = el.querySelectorAll<HTMLElement>("[data-hscroll]");
    clone.querySelectorAll<HTMLElement>("[data-hscroll]").forEach((c, i) => {
      c.style.scrollSnapType = "none";
      c.scrollLeft = scrollers[i]?.scrollLeft ?? 0;
    });
    el.style.visibility = "hidden";
    return () => {
      el.style.visibility = "";
      clone.remove();
    };
  }, [target.el, geo.rect.width]);

  useLayoutEffect(() => {
    haptic("light");
    animate(backdrop.current, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out", fill: "both" });
    animate(lift.current, [{ transform: `translate3d(0, ${geo.rect.top - geo.top}px, 0) scale(1)` }, { transform: "translate3d(0,0,0) scale(1.035)" }], { spring: SPRING_SNAPPY, fill: "both" });
    animate(bar.current, [{ transform: "scale(0.4)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { spring: SPRING_POP, fill: "both" });
    bar.current?.querySelectorAll<HTMLElement>("[data-qr]").forEach((n, i) =>
      animate(n, [{ transform: "scale(0) translateY(10px)", opacity: 0 }, { transform: "none", opacity: 1 }], { spring: SPRING_POP, delay: 30 + i * 22, fill: "both" }),
    );
    animate(menu.current, [{ transform: "scale(0.6)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { spring: SPRING_POP, delay: 20, fill: "both" });
  }, [geo]);

  const close = useCallback(
    (after?: () => void) => {
      if (closing.current) return;
      closing.current = true;
      const d = prefersReducedMotion() ? 1 : 150;
      const opts = { duration: d, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" as const };
      animate(backdrop.current, [{ opacity: 1 }, { opacity: 0 }], opts);
      animate(lift.current, [{ transform: "scale(1.035)" }, { transform: `translate3d(0, ${geo.rect.top - geo.top}px, 0) scale(1)` }], opts);
      for (const n of [bar.current, menu.current, picker.current]) animate(n, [{ opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(0.85)" }], opts);
      after?.();
      setTimeout(onClose, d);
    },
    [geo, onClose],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onResize = () => close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [close]);

  useLayoutEffect(() => {
    if (expanded) animate(picker.current, [{ transform: "scale(0.7)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { spring: SPRING_POP, fill: "both" });
  }, [expanded]);

  const pick = (emoji: string, node: Element | null) => {
    const r = node?.getBoundingClientRect();
    const from = r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: geo.barLeft + 40, y: geo.barTop + BAR_H / 2 };
    haptic("medium");
    close(() => onReact(emoji, from));
  };

  // "+" picker: inside the visible area (keyboard / safe-area aware), anchored where the bar was
  const pickerW = Math.min(360, geo.box.right - geo.box.left);
  const pickerLeft = clamp(target.mine ? geo.rect.right - pickerW : geo.rect.left, geo.box.left, geo.box.right - pickerW);
  const pickerH = Math.max(160, Math.min(340, geo.box.bottom - geo.box.top - 40));
  const pickerTop = clamp(geo.barTop, geo.box.top, geo.box.bottom - pickerH);

  return createPortal(
    <div ref={root} className="fixed inset-0 z-[90] touch-none select-none" data-testid="msg-overlay" role="dialog" aria-modal="true" aria-label="Message actions">
      <div
        ref={backdrop}
        className="absolute inset-0 bg-black/45 backdrop-blur-[6px] [-webkit-backdrop-filter:blur(6px)]"
        onPointerDown={(e) => {
          e.preventDefault();
          close();
        }}
      />
      <div
        ref={lift}
        className="pointer-events-none absolute [filter:drop-shadow(0_10px_24px_rgba(0,0,0,0.45))]"
        style={{ left: geo.rect.left, top: geo.top, width: geo.rect.width, maxHeight: geo.maxH, overflow: "hidden", transformOrigin: target.mine ? "right center" : "left center" }}
      />
      {!expanded && target.canReact && (
        <div
          ref={bar}
          data-testid="reaction-bar"
          className="absolute flex items-center gap-0.5 rounded-full bg-zinc-900/95 px-1.5 shadow-[0_8px_30px_rgba(0,0,0,0.5)] ring-1 ring-white/10"
          style={{ left: geo.barLeft, top: geo.barTop, height: BAR_H, width: geo.barW, transformOrigin: target.mine ? "right bottom" : "left bottom" }}
        >
          {QUICK_REACTIONS.slice(0, geo.nQuick).map((e) => (
            <button
              key={e}
              type="button"
              data-qr={e}
              aria-label={`React ${e}`}
              onClick={(ev) => pick(e, ev.currentTarget)}
              className={cn(
                "flex h-10 max-w-[38px] min-w-[34px] flex-1 items-center justify-center rounded-full transition-transform duration-150 hover:scale-125 active:scale-90 motion-reduce:transition-none",
                target.myReaction === e && "bg-emerald-500/25 ring-1 ring-emerald-400/60",
              )}
            >
              <AnimatedEmoji emoji={e} size={geo.barW < 340 ? 28 : 32} mode="loop" />
            </button>
          ))}
          <button
            type="button"
            aria-label="More reactions"
            data-testid="reaction-more"
            onClick={() => setExpanded(true)}
            className="ml-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-zinc-200 hover:bg-white/15"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      )}
      {expanded && (
        <div
          ref={picker}
          className="absolute overflow-hidden rounded-3xl bg-zinc-900/[0.97] shadow-[0_12px_40px_rgba(0,0,0,0.55)] ring-1 ring-white/10"
          style={{ left: pickerLeft, top: pickerTop, width: pickerW, transformOrigin: target.mine ? "right top" : "left top" }}
        >
          <EmojiPicker purpose="reaction" height={pickerH} onPick={(e) => pick(e, picker.current?.querySelector(`[data-emoji="${CSS.escape(e)}"]`) ?? null)} />
        </div>
      )}
      {!expanded && actions.length > 0 && (
        <div
          ref={menu}
          data-testid="msg-menu"
          className="absolute overflow-hidden rounded-2xl bg-zinc-900/95 py-1 shadow-[0_8px_30px_rgba(0,0,0,0.5)] ring-1 ring-white/10"
          style={{ left: geo.menuLeft, top: geo.menuTop, width: geo.menuW, transformOrigin: target.mine ? "right top" : "left top" }}
        >
          {target.meta && <div className="px-4 pt-1.5 pb-1 text-[11px] font-medium text-zinc-500">{target.meta}</div>}
          {actions.map((a) => (
            <button
              key={a.key}
              type="button"
              data-action={a.key}
              onClick={() => close(a.onSelect)}
              className={cn("flex w-full items-center px-4 text-left text-[15px] hover:bg-white/[0.06] active:bg-white/10", a.danger ? "text-red-400" : "text-zinc-100")}
              style={{ height: ITEM_H }}
            >
              <span className="mr-3 flex h-5 w-5 items-center justify-center opacity-90">{a.icon}</span>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

/** Where everything goes: the snapshot stays where the bubble was unless the bar / menu wouldn't fit. */
function layout(target: OverlayTarget, nActions: number) {
  const rect = target.el.getBoundingClientRect();
  // the usable box: visible viewport (on-screen keyboard) minus safe-area insets (notch, home bar, landscape sides)
  const vp = visibleViewport();
  const ins = safeInsets();
  const box = { left: EDGE + ins.left, right: vp.width - EDGE - ins.right, top: vp.top + EDGE + ins.top, bottom: vp.top + vp.height - EDGE - ins.bottom };
  const avail = box.right - box.left;
  const menuH = nActions ? nActions * ITEM_H + 8 + (target.meta ? 24 : 0) : 0;
  const barSpace = target.canReact ? BAR_H + GAP : 0;
  const minTop = box.top + barSpace;
  const maxH = Math.max(80, box.bottom - minTop - (menuH ? menuH + GAP : 0));
  const h = Math.min(rect.height, maxH);
  const maxTop = box.bottom - (menuH ? menuH + GAP : 0) - h;
  const top = Math.max(minTop, Math.min(rect.top, maxTop));
  // narrow screens (Fold cover, split view) show fewer quick reactions rather than shrinking the tap targets
  // per item: QR_W + 2 px gap; the bar adds 12 px padding, the "+" and its margin
  const nQuick = clamp(Math.floor((avail - 12 - MORE_W - 4) / (QR_W + 2)), 4, QUICK_REACTIONS.length);
  const barW = Math.min(avail, nQuick * (QR_W + 2) + 12 + MORE_W + 4);
  const barLeft = clamp(target.mine ? rect.right - barW : rect.left, box.left, box.right - barW);
  const barTop = top - GAP - BAR_H;
  const menuW = Math.min(240, avail);
  const menuLeft = clamp(target.mine ? rect.right - menuW : rect.left, box.left, box.right - menuW);
  const menuTop = top + h + GAP;
  return { rect, box, top, maxH, nQuick, barW, barLeft, barTop, menuW, menuLeft, menuTop };
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
