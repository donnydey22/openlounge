"use client";

import { MessageSquareReply } from "lucide-react";
import { useRef, useState } from "react";
import { haptic, prefersReducedMotion, spring, SPRING_SNAPPY } from "./emoji/motion";
import { carouselOwnsGesture } from "@/lib/media/gestures";

const REPLY_THRESHOLD = 56;
const MAX_DRAG = 88;
const IOS_BACK_SWIPE_GUTTER = 24;
const INTERACTIVE_SELECTOR = 'button, a[href], input, textarea, select, [contenteditable="true"], [role="slider"], [data-testid="media-voice"]';

/** Rich message controls own their tap/drag; visual media remains replyable outside its actual controls. */
function replyGestureBlocked(target: EventTarget | null, clientX: number) {
  if (clientX <= IOS_BACK_SWIPE_GUTTER || carouselOwnsGesture(target)) return true;
  return target instanceof Element && !!target.closest(INTERACTIVE_SELECTOR);
}

/**
 * A passive horizontal gesture that leaves vertical scrolling intact. It works around every
 * message body (including media/cards) and triggers the wrapper haptic bridge when available.
 */
export function ReplyGesture({ children, onReply, disabled = false, testId, messageId }: { children: React.ReactNode; onReply: () => void; disabled?: boolean; testId?: string; messageId?: string }) {
  const [dx, setDx] = useState(0);
  const settle = spring(SPRING_SNAPPY);
  const gesture = useRef<{ id: number; x: number; y: number; axis: "x" | "y" | null; armed: boolean }>({ id: -1, x: 0, y: 0, axis: null, armed: false });

  const reset = () => {
    gesture.current = { id: -1, x: 0, y: 0, axis: null, armed: false };
    setDx(0);
  };
  const reply = () => {
    haptic("medium");
    onReply();
  };

  return (
    <div className="group/reply relative" data-testid={testId} data-reply-message={messageId}>
      <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-emerald-400" aria-hidden style={{ opacity: Math.min(1, dx / REPLY_THRESHOLD) }}>
        <MessageSquareReply className="h-5 w-5" />
      </span>
      <button
        type="button"
        onClick={reply}
        className="absolute top-1/2 left-1 hidden -translate-y-1/2 rounded-full bg-zinc-800 p-1.5 text-zinc-400 shadow ring-1 ring-white/10 transition hover:bg-zinc-700 hover:text-emerald-400 [@media(hover:hover)_and_(pointer:fine)]:group-hover/reply:flex"
        aria-label="Reply to message"
        data-testid="reply-desktop"
        disabled={disabled}
      >
        <MessageSquareReply className="h-4 w-4" />
      </button>
      <div
        style={{
          transform: dx ? `translate3d(${dx}px,0,0)` : undefined,
          transition: gesture.current.axis === "x" || prefersReducedMotion() ? "none" : `transform ${settle.duration}ms ${settle.easing}`,
          touchAction: "pan-y",
        }}
        onPointerDown={(event) => {
          if (disabled || (event.pointerType !== "touch" && event.pointerType !== "pen") || !event.isPrimary) return;
          // This is deliberately bubble-phase: AlbumCarousel writes data-hscroll-pass on its own pointerdown first.
          if (replyGestureBlocked(event.target, event.clientX)) {
            reset();
            return;
          }
          gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null, armed: false };
        }}
        onPointerMoveCapture={(event) => {
          const g = gesture.current;
          if (g.id !== event.pointerId || disabled) return;
          const mx = event.clientX - g.x;
          const my = event.clientY - g.y;
          if (!g.axis && (Math.abs(mx) > 8 || Math.abs(my) > 8)) g.axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
          if (g.axis !== "x") return;
          const next = Math.max(0, Math.min(MAX_DRAG, mx));
          if (!g.armed && next >= REPLY_THRESHOLD) {
            g.armed = true;
            haptic("light");
          }
          setDx(next);
        }}
        onPointerUpCapture={(event) => {
          const g = gesture.current;
          if (g.id !== event.pointerId) return;
          const complete = g.axis === "x" && g.armed;
          reset();
          if (complete) {
            // The nested rich message may also have a tap handler. A completed swipe is never a tap.
            event.preventDefault();
            event.stopPropagation();
            reply();
          }
        }}
        onPointerCancelCapture={reset}
      >
        {children}
      </div>
    </div>
  );
}
