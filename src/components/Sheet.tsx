"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { lockAppScroll } from "@/lib/scrollLock";

/** Mobile-style bottom sheet (centered dialog on larger screens). */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  /** Optional sticky footer (primary action) that stays visible above the keyboard. */
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Keyboard-aware: cap the sheet to the *visual* viewport (iOS/Android keyboards shrink it)
  // and keep the focused field in view.
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const vv = window.visualViewport;
    const el = panel.current;
    const root = el?.parentElement;
    // Pin the overlay to the *visual* viewport so the sheet rises above the on-screen keyboard
    // (iOS Safari / WKWebView / Android WebView) instead of sliding behind it.
    const fit = () => {
      const h = Math.round(vv?.height ?? window.innerHeight);
      el?.style.setProperty("--sheet-vh", `${h}px`);
      if (root) {
        root.style.height = `${h}px`;
        root.style.top = `${Math.round(vv?.offsetTop ?? 0)}px`;
        const kb = window.innerHeight - h - (vv?.offsetTop ?? 0);
        root.dataset.kbd = kb > 80 ? "1" : "0";
      }
    };
    fit();
    vv?.addEventListener("resize", fit, { passive: true });
    vv?.addEventListener("scroll", fit, { passive: true });
    const unlock = lockAppScroll(); // background (app shell) can't scroll or jump while the sheet is open
    const onFocus = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) setTimeout(() => t.scrollIntoView({ block: "nearest", behavior: "smooth" }), 300);
    };
    el?.addEventListener("focusin", onFocus);
    return () => {
      vv?.removeEventListener("resize", fit);
      vv?.removeEventListener("scroll", fit);
      unlock();
      el?.removeEventListener("focusin", onFocus);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div data-ol-sheet className="group fixed inset-x-0 top-0 z-50 flex h-[100dvh] items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal>
      <div className="fade-in absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={panel}
        className="sheet-in relative flex max-h-[min(92svh,calc(var(--sheet-vh,100dvh)-env(safe-area-inset-top,0px)-8px))] w-full min-w-0 max-w-lg flex-col overflow-hidden rounded-t-[28px] border border-white/5 bg-zinc-900 pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)] shadow-2xl sm:max-h-[min(85dvh,calc(var(--sheet-vh,100dvh)-3rem))] sm:rounded-3xl"
      >
        <div className="shrink-0 px-5 pt-2.5 sm:pt-5">
          <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-zinc-700 sm:hidden" aria-hidden />
          {title && (
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight">{title}</h2>
              <button onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-white" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
          )}
        </div>
        <div
          className={
            "min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 [scroll-padding-bottom:1.5rem] " +
            (footer ? "pb-4" : "pb-[max(2rem,calc(env(safe-area-inset-bottom,0px)+1rem))]")
          }
        >
          {children}
        </div>
        {footer && (
          <div className="shrink-0 border-t border-white/5 bg-zinc-900/95 px-5 pt-3 pb-[max(1rem,calc(env(safe-area-inset-bottom,0px)+0.5rem))] backdrop-blur group-data-[kbd=1]:pb-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
