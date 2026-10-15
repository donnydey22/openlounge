"use client";

import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Full-screen group page (new group, group info, invite preview): fixed header + one scrolling body, pinned to the
 * visual viewport so an on-screen keyboard never pushes the header away (same approach as the DM thread page).
 * No dvh / container queries: `fixed inset-0` works back to iOS 15 / Android 7 WebView, the visual viewport refines it.
 */
export function GroupScreen({
  title,
  onBack,
  right,
  children,
  footer,
  testId,
}: {
  title: React.ReactNode;
  onBack: () => void;
  right?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  testId?: string;
}) {
  const vv = useVisualViewport();
  return (
    <div
      data-ol-screen
      className="fixed inset-x-0 top-0 bottom-0 z-10 bg-app"
      style={vv ? { height: vv.h, bottom: "auto", transform: vv.top ? `translateY(${vv.top}px)` : undefined } : undefined}
      data-testid={testId}
    >
      <div className="mx-auto flex h-full max-w-2xl flex-col">
        <header data-app-header className="flex h-14 shrink-0 items-center gap-1 border-b border-white/5 px-1.5">
          <button onClick={onBack} className="shrink-0 rounded-full p-2 text-zinc-300 hover:bg-white/5" aria-label="Back">
            <ChevronLeft className="h-6 w-6" />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold">{title}</h1>
          {right && <div className="flex shrink-0 items-center">{right}</div>}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        {footer && <div data-ol-bottom-pad className="shrink-0 border-t border-white/5 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>
  );
}

export function useVisualViewport() {
  const [vv, setVv] = useState<{ h: number; top: number } | null>(null);
  useEffect(() => {
    const v = window.visualViewport;
    if (!v) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setVv((prev) => (prev && prev.h === v.height && prev.top === v.offsetTop ? prev : { h: v.height, top: v.offsetTop }));
        if (window.scrollY !== 0) window.scrollTo(0, 0);
      });
    };
    update();
    v.addEventListener("resize", update);
    v.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("resize", update);
      v.removeEventListener("scroll", update);
    };
  }, []);
  return vv;
}

/** A tappable settings-style row. */
export function Row({
  icon,
  label,
  hint,
  onClick,
  danger,
  right,
  testId,
}: {
  icon?: React.ReactNode;
  label: React.ReactNode;
  hint?: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
  right?: React.ReactNode;
  testId?: string;
}) {
  const body = (
    <>
      {icon && <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center", danger ? "text-red-400" : "text-zinc-400")}>{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[15px]", danger ? "font-medium text-red-400" : "text-zinc-100")}>{label}</span>
        {hint && <span className="block truncate text-xs text-zinc-500">{hint}</span>}
      </span>
      {right}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3.5 px-4 py-3 text-left hover:bg-white/5 active:bg-white/[0.07]" data-testid={testId}>
      {body}
    </button>
  ) : (
    <div className="flex w-full items-center gap-3.5 px-4 py-3" data-testid={testId}>
      {body}
    </div>
  );
}

export function Section({ title, children }: { title?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-3 border-y border-white/5 bg-zinc-900/40 sm:mx-3 sm:rounded-2xl sm:border">
      {title && <h2 className="px-4 pt-3 pb-1 text-[12px] font-semibold tracking-wide text-emerald-400 uppercase">{title}</h2>}
      {children}
    </section>
  );
}
