"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useApp, type Toast } from "./AppProvider";
import { Avatar } from "./Avatar";
import { ICON, routeTo } from "@/lib/notify";
import { cn } from "@/lib/utils";

/** How long a banner stays up; shortened when others are waiting so nothing piles up. */
const SHOW_MS = 3500;
const SHOW_MS_QUEUED = 1800;
const EXIT_MS = 200;

/**
 * The app's single in-app notice surface: one compact banner at a time, anchored just below the
 * app header (+ safe area), in the slot above the page content (the hallway reserves it above the
 * greeting), so it never covers the header, the stage avatars, the bottom control bar or the chat input.
 * Tap opens the room/DM, swipe up (or tap a plain one) dismisses. Slides in/out; fade only with
 * prefers-reduced-motion (see .banner-in / .banner-out in globals.css).
 */
export function Toasts() {
  const { toasts, dismissToast } = useApp();
  const current = toasts[0];
  const queued = toasts.length > 1;
  const pathname = usePathname();
  const showing = !!current;

  // Anchor to the bottom edge of whatever app header is on screen ([data-app-header]: TopBar,
  // room header, DM header), measured, not hard-coded. No header (sign-in) → just the safe area.
  useLayoutEffect(() => {
    if (!showing) return;
    const measure = () => {
      try {
        let bottom = 0;
        document.querySelectorAll<HTMLElement>("[data-app-header]").forEach((h) => {
          const r = h.getBoundingClientRect();
          if (r.height > 0 && r.top < 48 && r.bottom > 0) bottom = Math.max(bottom, r.bottom);
        });
        document.documentElement.style.setProperty("--ol-header-bottom", `${Math.round(bottom)}px`);
      } catch {
        /* keep the previous value */
      }
    };
    measure();
    const raf = requestAnimationFrame(measure); // after route content paints
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver(measure);
      document.querySelectorAll("[data-app-header]").forEach((h) => ro!.observe(h));
    } catch {
      ro = null;
    }
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      ro?.disconnect();
    };
  }, [showing, pathname, current?.id]);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-3"
      style={{ top: "max(calc(env(safe-area-inset-top, 0px) + var(--ol-banner-gap, 8px)), calc(var(--ol-header-bottom, 0px) + var(--ol-banner-gap, 8px)))" }}
      aria-live="polite"
      data-testid="banner-region"
    >
      {current && <Banner key={current.id} t={current} queued={queued} onDone={dismissToast} />}
    </div>
  );
}

function Banner({ t, queued, onDone }: { t: Toast; queued: boolean; onDone: (id: number) => void }) {
  const router = useRouter();
  const { presenceOf } = useApp();
  const [leaving, setLeaving] = useState(false);
  const [dy, setDy] = useState(0);
  const start = useRef<{ y: number; x: number; moved: boolean } | null>(null);
  const shownAt = useRef(Date.now());

  const close = useCallback(() => {
    setLeaving(true);
    window.setTimeout(() => onDone(t.id), EXIT_MS);
  }, [onDone, t.id]);

  // auto-dismiss (restarts when the content is replaced in place, shortens when others wait)
  useEffect(() => {
    if (leaving) return;
    if (t.rev > 0) shownAt.current = Date.now();
    const total = queued ? SHOW_MS_QUEUED : SHOW_MS;
    const left = Math.max(400, total - (Date.now() - shownAt.current));
    const timer = window.setTimeout(close, left);
    return () => window.clearTimeout(timer);
  }, [t.rev, queued, leaving, close]);

  const onPointerDown = (e: React.PointerEvent) => {
    start.current = { y: e.clientY, x: e.clientX, moved: false };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const d = e.clientY - start.current.y;
    if (Math.abs(d) > 6 || Math.abs(e.clientX - start.current.x) > 6) start.current.moved = true;
    setDy(Math.min(0, d));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const d = e.clientY - s.y;
    if (d < -24) {
      close(); // swipe up
      return;
    }
    setDy(0);
    if (s.moved) return;
    if (t.href) routeTo(t.href, (h) => router.push(h));
    close();
  };

  // Same card for everything (notifications and plain status toasts like "A moderator muted you"):
  // squircle avatar (person) or app icon, bold title, optional one muted line. Fixed height so it
  // always fits the slot between the header and the page content (--ol-banner-h).
  const person = t.avatar && t.avatar !== "app" ? t.avatar : null;
  return (
    <div
      role="status"
      data-testid="banner"
      data-kind={t.kind}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        start.current = null;
        setDy(0);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && t.href) routeTo(t.href, (h) => router.push(h));
        if (e.key === "Enter" || e.key === "Escape") close();
      }}
      tabIndex={0}
      // `translate` (not transform) so it composes with the slide animation's transform
      style={{ height: "var(--ol-banner-h, 52px)", ...(dy ? { translate: `0 ${dy}px` } : null) }}
      className={cn(
        "pointer-events-auto flex w-full max-w-none sm:max-w-[360px] cursor-pointer touch-none items-center gap-2.5 overflow-hidden rounded-[1.1rem] border border-white/10 bg-zinc-900/85 py-0 pr-4 pl-2 shadow-xl backdrop-blur-xl backdrop-saturate-150 outline-none select-none focus-visible:ring-2 focus-visible:ring-emerald-500/50",
        leaving ? "banner-out" : "banner-in",
      )}
    >
      {person ? (
        <Avatar name={person.name} color={person.color} photo={person.photo} size="banner" presence={person.userId && presenceOf(person.userId) !== "offline" ? (presenceOf(person.userId) as "online" | "away") : null} />
      ) : (
        <span className="relative block h-9 w-9 shrink-0 overflow-hidden rounded-full" aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={ICON} alt="" className="h-full w-full object-cover" draggable={false} />
        </span>
      )}
      <span className="min-w-0 flex-1 leading-tight">
        <span className={cn("block text-[14px] font-semibold text-zinc-50", t.body ? "truncate" : "line-clamp-2")}>{t.message}</span>
        {t.body && <span className="mt-0.5 block truncate text-[13px] text-zinc-400">{t.body}</span>}
      </span>
    </div>
  );
}
