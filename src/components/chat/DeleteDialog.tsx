"use client";
// Telegram-style "Delete message?" dialog. 1:1 chats: "Also delete for <name>" (only when every selected message is
// mine). Groups: delete for everyone is the only kind (sender or admin), so it just says so.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { animate, SPRING_POP } from "./emoji/motion";

export function DeleteDialog({
  count,
  peerName,
  canForEveryone,
  group,
  onCancel,
  onConfirm,
}: {
  count: number;
  /** first name of the 1:1 peer (checkbox label) */
  peerName?: string;
  canForEveryone: boolean;
  group?: boolean;
  onCancel: () => void;
  onConfirm: (forEveryone: boolean) => void;
}) {
  const [both, setBoth] = useState(true);
  const card = useRef<HTMLDivElement>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    animate(card.current, [{ transform: "scale(0.86)", opacity: 0 }, { transform: "scale(1)", opacity: 1 }], { spring: SPRING_POP, fill: "both" });
    confirmBtn.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const title = count === 1 ? "Delete message?" : `Delete ${count} messages?`;
  return createPortal(
    <div className="fixed inset-0 z-[95] flex items-center justify-center p-6" data-testid="delete-dialog">
      <div className="fade-in absolute inset-0 bg-black/55" onPointerDown={onCancel} />
      <div
        ref={card}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="del-title"
        className="relative w-full max-w-[320px] rounded-2xl bg-zinc-900 p-5 shadow-[0_20px_60px_rgba(0,0,0,0.6)] ring-1 ring-white/10"
      >
        <h2 id="del-title" className="text-[17px] font-semibold text-zinc-100">
          {title}
        </h2>
        <p className="mt-1.5 text-[14px] leading-snug text-zinc-400">
          {group
            ? count === 1
              ? "This message will be deleted for all members."
              : "These messages will be deleted for all members."
            : count === 1
              ? "Are you sure you want to delete this message?"
              : "Are you sure you want to delete these messages?"}
        </p>
        {!group && canForEveryone && peerName && (
          <label className="mt-4 flex cursor-pointer items-center text-[15px] text-zinc-200 select-none" data-testid="delete-both">
            <input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} className="peer sr-only" />
            <span
              aria-hidden
              className="mr-3 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md border-2 border-zinc-500 transition-colors peer-checked:border-emerald-500 peer-checked:bg-emerald-500 peer-focus-visible:ring-2 peer-focus-visible:ring-emerald-400/60"
            >
              {both && (
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-zinc-950" fill="none" stroke="currentColor" strokeWidth="2.6">
                  <path d="M3 8.5l3.2 3L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </span>
            Also delete for {peerName}
          </label>
        )}
        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onCancel} className="mr-2 h-10 rounded-full px-4 text-[15px] font-semibold text-emerald-400 hover:bg-white/5">
            Cancel
          </button>
          <button
            ref={confirmBtn}
            type="button"
            data-testid="delete-confirm"
            onClick={() => onConfirm(group ? true : canForEveryone && both)}
            className="h-10 rounded-full px-4 text-[15px] font-semibold text-red-400 hover:bg-red-500/10"
          >
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
