"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";

/** Mobile-style bottom sheet (centered dialog on larger screens). */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
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
    const fit = () => el?.style.setProperty("--sheet-vh", `${Math.round(vv?.height ?? window.innerHeight)}px`);
    fit();
    vv?.addEventListener("resize", fit, { passive: true });
    const onFocus = (e: FocusEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) setTimeout(() => t.scrollIntoView({ block: "center", behavior: "smooth" }), 250);
    };
    el?.addEventListener("focusin", onFocus);
    return () => {
      vv?.removeEventListener("resize", fit);
      el?.removeEventListener("focusin", onFocus);
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal>
      <div className="fade-in absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={panel}
        className="sheet-in relative max-h-[min(85dvh,calc(var(--sheet-vh,100dvh)-env(safe-area-inset-top,0px)-12px))] w-full max-w-lg overflow-y-auto overscroll-contain rounded-t-3xl border border-white/5 bg-zinc-900 p-5 pb-[max(2rem,calc(env(safe-area-inset-bottom,0px)+1rem))] shadow-2xl [scroll-padding-bottom:6rem] sm:rounded-3xl"
      >
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-zinc-700 sm:hidden" />
        {title && (
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">{title}</h2>
            <button onClick={onClose} className="rounded-full p-1.5 text-zinc-400 hover:bg-white/5 hover:text-white" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
