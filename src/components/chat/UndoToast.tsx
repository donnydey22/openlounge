"use client";
// "Message deleted • Undo" for 5 s with a draining ring (Telegram). The delete is committed when it closes.
import { useEffect, useState } from "react";

export const UNDO_MS = 5000;

export function UndoToast({ label, onUndo, startedAt }: { label: string; onUndo: () => void; startedAt: number }) {
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((UNDO_MS - (Date.now() - startedAt)) / 1000)));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.ceil((UNDO_MS - (Date.now() - startedAt)) / 1000))), 250);
    return () => clearInterval(t);
  }, [startedAt]);
  const R = 9;
  const C = 2 * Math.PI * R;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="undo-toast"
      className="toast-in pointer-events-auto absolute bottom-3 left-1/2 z-20 flex w-[min(92%,360px)] -translate-x-1/2 items-center rounded-2xl bg-zinc-800/95 py-2 pr-2 pl-3 text-[14px] text-zinc-100 shadow-[0_10px_30px_rgba(0,0,0,0.5)] ring-1 ring-white/10"
    >
      <span className="relative mr-3 flex h-6 w-6 shrink-0 items-center justify-center">
        <svg viewBox="0 0 24 24" className="absolute inset-0 -rotate-90" aria-hidden>
          <circle cx="12" cy="12" r={R} fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="2" />
          <circle
            cx="12"
            cy="12"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray={C}
            className="undo-ring text-emerald-400"
            style={{ animationDuration: `${UNDO_MS}ms`, animationDelay: `${-(Date.now() - startedAt)}ms` }}
          />
        </svg>
        <span className="text-[11px] font-semibold tabular-nums">{left}</span>
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <button type="button" onClick={onUndo} data-testid="undo" className="ml-2 h-9 shrink-0 rounded-full px-3 font-semibold text-emerald-400 hover:bg-white/5">
        Undo
      </button>
    </div>
  );
}
