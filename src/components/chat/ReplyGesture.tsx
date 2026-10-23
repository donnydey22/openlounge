"use client";

import { MessageSquareReply } from "lucide-react";
import { useEffect, useRef } from "react";
import { animate, haptic, prefersReducedMotion, SPRING_POP } from "./emoji/motion";
import { carouselOwnsGesture } from "@/lib/media/gestures";
import { AXIS_LOCK_PX, REPLY_THRESHOLD, iconStyle, releaseVelocity, rubberBand, springStep } from "@/lib/chat/replySpring";

const IOS_BACK_SWIPE_GUTTER = 24;
const INTERACTIVE_SELECTOR = 'button, a[href], input, textarea, select, [contenteditable="true"], [role="slider"], [data-testid="media-voice"]';

/** Rich message controls own their tap/drag; visual media remains replyable outside its actual controls. */
function replyGestureBlocked(target: EventTarget | null, clientX: number) {
  if (clientX <= IOS_BACK_SWIPE_GUTTER || carouselOwnsGesture(target)) return true;
  return target instanceof Element && !!target.closest(INTERACTIVE_SELECTOR);
}

/** Mouse only: pressing on already-selected text starts a native drag of that text, not a swipe. */
const onSelectedText = (x: number, y: number) => {
  try {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString()) return false;
    for (let i = 0; i < sel.rangeCount; i++) {
      for (const r of Array.from(sel.getRangeAt(i).getClientRects())) if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    return false;
  } catch {
    return false;
  }
};

/** Long-press (text selection / context menu) wins: a drag that only starts after this is not a swipe. */
const LONG_PRESS_MS = 450;

/**
 * Mouse only: is the pointer over actual text glyphs? Dragging across text keeps selecting text exactly as before;
 * the mouse swipe starts from the bubble's padding, media or empty space (where a drag selects nothing anyway).
 */
function pointerOverText(x: number, y: number) {
  try {
    const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null; caretRangeFromPoint?: (x: number, y: number) => Range | null };
    let node: Node | null = null;
    let offset = 0;
    if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(x, y);
      if (pos) ({ offsetNode: node, offset } = pos);
    } else if (doc.caretRangeFromPoint) {
      const r = doc.caretRangeFromPoint(x, y);
      if (r) ({ startContainer: node, startOffset: offset } = r);
    }
    if (!node || node.nodeType !== Node.TEXT_NODE || !(node.textContent || "").trim()) return false;
    const len = node.textContent!.length;
    const range = document.createRange();
    for (const i of [offset - 1, offset]) {
      if (i < 0 || i >= len) continue;
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      for (const rect of Array.from(range.getClientRects())) {
        if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top - 1 && y <= rect.bottom + 1) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** A finished horizontal drag is never a click on the dragged bubble (media tiles / links under the pointer stay closed). */
function swallowNextClick(el: HTMLElement | null) {
  const stop = (e: Event) => {
    if (!el || !(e.target instanceof Node) || !el.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener("click", stop, true);
  };
  window.addEventListener("click", stop, true);
  setTimeout(() => window.removeEventListener("click", stop, true), 400);
}

type Gesture = { id: number; t: number; x: number; y: number; axis: "x" | "y" | null; armed: boolean; mouse: boolean; samples: { t: number; x: number }[] };
const idle = (): Gesture => ({ id: -1, t: 0, x: 0, y: 0, axis: null, armed: false, mouse: false, samples: [] });

/**
 * WhatsApp-style swipe right to reply (touch, pen and mouse). The bubble follows the pointer 1:1 to the threshold,
 * then with rubber-band resistance; the reply icon fades and scales in with the drag and pops (with a haptic tick)
 * the moment the reply is armed. Dragging back below the threshold cancels. On release the bubble springs home with
 * the pointer's velocity and the reply bar opens. Vertical scrolling (touch-action: pan-y) and text selection are
 * untouched: nothing moves until the gesture locks to the horizontal axis, a touch long-press still selects, and a
 * mouse drag that starts on text glyphs still selects text (mouse swipes start from padding, media or empty space). Moves are written straight to the DOM (no
 * React re-render per frame), so long threads with media stay at 60 fps.
 */
export function ReplyGesture({ children, onReply, disabled = false, testId, messageId }: { children: React.ReactNode; onReply: () => void; disabled?: boolean; testId?: string; messageId?: string }) {
  const body = useRef<HTMLDivElement>(null);
  const icon = useRef<HTMLSpanElement>(null);
  const gesture = useRef<Gesture>(idle());
  const offset = useRef(0);
  const raf = useRef(0);
  const unlockSelection = useRef<(() => void) | null>(null);
  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;

  const paint = (x: number, armed: boolean) => {
    offset.current = x;
    const el = body.current;
    if (el) el.style.transform = x ? `translate3d(${x}px,0,0)` : "";
    const ic = icon.current;
    if (ic) {
      const s = iconStyle(x, armed);
      ic.style.opacity = String(s.opacity);
      ic.style.transform = `translate3d(${s.x}px,0,0) scale(${s.scale})`;
    }
  };

  const stopSpring = () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0;
  };

  const springHome = (v0: number) => {
    stopSpring();
    if (prefersReducedMotion() || !offset.current) return paint(0, false);
    let x = offset.current;
    let v = Math.min(0, v0); // only carry velocity that points home
    let last = performance.now();
    const tick = (now: number) => {
      // fixed 1/240 s sub-steps: stable at any frame rate (60/120 Hz, throttled background tabs)
      let dt = Math.min(0.064, (now - last) / 1000);
      last = now;
      while (dt > 0) {
        const h = Math.min(dt, 1 / 240);
        [x, v] = springStep(x, v, h);
        dt -= h;
      }
      if (Math.abs(x) < 0.5 && Math.abs(v) < 10) {
        raf.current = 0;
        return paint(0, false);
      }
      paint(Math.max(-4, x), false);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };

  const end = (complete: boolean) => {
    const g = gesture.current;
    const v = releaseVelocity(g.samples);
    const wasX = g.axis === "x";
    gesture.current = idle();
    unlockSelection.current?.();
    unlockSelection.current = null;
    if (wasX) swallowNextClick(body.current);
    springHome(v);
    if (complete) {
      haptic("medium");
      onReplyRef.current();
    }
  };

  // Trackpad: a two-finger horizontal swipe over the bubble works like the drag (macOS / Windows precision touchpads
  // send it as horizontal wheel deltas). Non-passive only so the browser's back-swipe doesn't fire while we own it;
  // vertical / diagonal scrolling and pinch-zoom (ctrlKey) pass straight through.
  const wheel = useRef<{ x: number; armed: boolean; timer: ReturnType<typeof setTimeout> | null }>({ x: 0, armed: false, timer: null });
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    // Once a swipe starts, the bubble slides out from under the pointer, so the rest of the swipe is followed from a
    // window listener that only exists while the swipe is live (no global non-passive wheel listener otherwise).
    const finish = () => {
      const w = wheel.current;
      const complete = w.armed;
      window.removeEventListener("wheel", onFollow, { capture: true });
      wheel.current = { x: 0, armed: false, timer: null };
      springHome(0);
      if (complete) {
        haptic("medium");
        onReplyRef.current();
      }
    };
    const step = (e: WheelEvent) => {
      const w = wheel.current;
      e.preventDefault();
      const px = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaMode === 2 ? e.deltaX * 400 : e.deltaX;
      w.x = Math.max(0, w.x - px);
      stopSpring();
      const armed = w.x >= REPLY_THRESHOLD;
      if (armed !== w.armed) {
        w.armed = armed;
        if (armed) {
          haptic("light");
          animate(icon.current?.firstElementChild, [{ transform: "scale(1)" }, { transform: "scale(1.22)" }, { transform: "scale(1)" }], { spring: SPRING_POP });
        }
      }
      paint(rubberBand(w.x), armed);
      if (w.timer) clearTimeout(w.timer);
      w.timer = setTimeout(finish, 140); // the swipe ends when the deltas stop (incl. momentum tail)
    };
    function onFollow(e: WheelEvent) {
      if (e.ctrlKey) return;
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.5) return; // vertical inertia mid-swipe: ignore, the timer ends it
      step(e);
    }
    const onWheel = (e: WheelEvent) => {
      if (wheel.current.timer || disabledRef.current || e.ctrlKey || gesture.current.id !== -1) return;
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5;
      if (!horizontal || e.deltaX >= 0) return; // starts only with a rightward swipe
      if (replyGestureBlocked(e.target, Number.MAX_SAFE_INTEGER)) return;
      window.addEventListener("wheel", onFollow, { capture: true, passive: false });
      step(e);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("wheel", onFollow, { capture: true });
      if (wheel.current.timer) clearTimeout(wheel.current.timer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(
    () => () => {
      stopSpring();
      unlockSelection.current?.();
    },
    [],
  );

  return (
    <div
      className="group/reply relative"
      data-testid={testId}
      data-reply-message={messageId}
      onKeyDown={(e) => {
        // keyboard fallback: Alt+R while anything inside the message has focus (its reply button, a link, media)
        if (disabled || e.defaultPrevented || e.metaKey || e.ctrlKey) return;
        const t = e.target as HTMLElement;
        const typing = t.closest('input, textarea, [contenteditable="true"]');
        if (typing || !e.altKey || (e.code !== "KeyR" && e.key.toLowerCase() !== "r")) return;
        e.preventDefault();
        haptic("medium");
        onReplyRef.current();
      }}
    >
      <span ref={icon} className="pointer-events-none absolute inset-y-0 left-2 flex items-center will-change-transform" aria-hidden style={{ opacity: 0, transform: "scale(0.35)" }} data-testid="reply-swipe-icon">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-zinc-800/90 text-emerald-400 shadow ring-1 ring-white/10">
          <MessageSquareReply className="h-4 w-4" />
        </span>
      </span>
      <button
        type="button"
        onClick={() => {
          haptic("medium");
          onReply();
        }}
        className="pointer-events-none absolute top-1/2 left-1 flex -translate-y-1/2 rounded-full bg-zinc-800 p-1.5 text-zinc-400 opacity-0 shadow ring-1 ring-white/10 transition hover:bg-zinc-700 hover:text-emerald-400 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-emerald-500/70 [@media(hover:hover)_and_(pointer:fine)]:group-hover/reply:pointer-events-auto [@media(hover:hover)_and_(pointer:fine)]:group-hover/reply:opacity-100"
        aria-label="Reply to message"
        data-testid="reply-desktop"
        disabled={disabled}
      >
        <MessageSquareReply className="h-4 w-4" />
      </button>
      <div
        ref={body}
        style={{ touchAction: "pan-y" }}
        data-testid="reply-swipe-body"
        onPointerDown={(event) => {
          if (disabled || !event.isPrimary) return;
          const mouse = event.pointerType === "mouse";
          if (mouse && (event.button !== 0 || onSelectedText(event.clientX, event.clientY) || pointerOverText(event.clientX, event.clientY))) {
            gesture.current = idle();
            return;
          }
          // This is deliberately bubble-phase: AlbumCarousel writes data-hscroll-pass on its own pointerdown first.
          if (replyGestureBlocked(event.target, event.clientX)) {
            gesture.current = idle();
            return;
          }
          stopSpring();
          gesture.current = { id: event.pointerId, t: performance.now(), x: event.clientX - offset.current, y: event.clientY, axis: null, armed: false, mouse, samples: [{ t: event.timeStamp || performance.now(), x: event.clientX }] };
        }}
        onPointerMoveCapture={(event) => {
          const g = gesture.current;
          if (g.id !== event.pointerId || disabled) return;
          const mx = event.clientX - g.x;
          const my = event.clientY - g.y;
          if (!g.axis && (Math.abs(mx) > AXIS_LOCK_PX || Math.abs(my) > AXIS_LOCK_PX)) {
            const late = !g.mouse && performance.now() - g.t > LONG_PRESS_MS;
            g.axis = !late && Math.abs(mx) > Math.abs(my) && mx > 0 ? "x" : "y";
            if (g.axis === "y") {
              gesture.current = idle();
              return;
            }
            // locked horizontal: keep the pointer even if it leaves the bubble, and stop a mouse drag from selecting text
            try {
              body.current?.setPointerCapture(event.pointerId);
            } catch {
              /* synthetic or already-released pointer */
            }
            if (g.mouse) {
              try {
                window.getSelection()?.removeAllRanges();
              } catch {}
              const block = (e: Event) => e.preventDefault();
              const prev = document.body.style.userSelect;
              document.body.style.userSelect = "none";
              document.addEventListener("selectstart", block, true);
              unlockSelection.current = () => {
                // the browser may have started a selection from the padding before the axis locked; a swipe selects nothing
                try {
                  window.getSelection()?.removeAllRanges();
                } catch {}
                document.body.style.userSelect = prev;
                document.removeEventListener("selectstart", block, true);
              };
            }
          }
          if (g.axis !== "x") return;
          g.samples.push({ t: event.timeStamp || performance.now(), x: event.clientX });
          if (g.samples.length > 8) g.samples.shift();
          const armed = mx >= REPLY_THRESHOLD;
          if (armed !== g.armed) {
            g.armed = armed;
            if (armed) {
              haptic("light");
              animate(icon.current?.firstElementChild, [{ transform: "scale(1)" }, { transform: "scale(1.22)" }, { transform: "scale(1)" }], { spring: SPRING_POP });
            }
          }
          paint(rubberBand(mx), armed);
        }}
        onPointerUpCapture={(event) => {
          const g = gesture.current;
          if (g.id !== event.pointerId) return;
          const complete = g.axis === "x" && event.clientX - g.x >= REPLY_THRESHOLD;
          if (complete) {
            // The nested rich message may also have a tap handler. A completed swipe is never a tap.
            event.preventDefault();
            event.stopPropagation();
          }
          end(complete);
        }}
        onPointerCancelCapture={(event) => {
          if (gesture.current.id === event.pointerId) end(false);
        }}
        onLostPointerCapture={(event) => {
          if (gesture.current.id === event.pointerId && gesture.current.axis === "x") end(false);
        }}
      >
        {children}
      </div>
    </div>
  );
}
