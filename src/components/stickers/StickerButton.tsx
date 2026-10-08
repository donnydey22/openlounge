"use client";
// Composer hook: a sticker button that toggles the StickerPanel above the composer and sends the picked sticker
// through the composer's normal onSend path (DMs: optimistic bubble + retry; room chat: chat:send).
import { useCallback, useEffect, useRef, useState } from "react";
import { Sticker as StickerIcon } from "lucide-react";
import { StickerPanel } from "./StickerPanel";
import { stickerText } from "@/lib/stickers/token";
import { loadCatalog } from "@/lib/stickers/client";
import type { Sticker } from "@/lib/stickers/types";
import { cn } from "@/lib/utils";

export function StickerButton({ onSend, disabled, compact }: { onSend: (text: string) => Promise<boolean>; disabled?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  // prefetch the catalog on hover/focus so the panel opens filled
  const warm = () => void loadCatalog();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const form = root.current?.closest("form") ?? root.current;
      if (form && !form.contains(e.target as Node) && !(e.target as Element)?.closest?.("[role=dialog]")) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const pick = useCallback(
    (packId: string, s: Sticker) => {
      // close so the sent sticker is visible (the panel overlays the message list); Recent keeps re-sends one tap away
      setOpen(false);
      void onSend(stickerText({ packId, stickerId: s.id, emoji: s.emoji }));
    },
    [onSend],
  );

  return (
    <div ref={root} className="contents">
      <button
        type="button"
        disabled={disabled}
        onPointerEnter={warm}
        onFocus={warm}
        onClick={() => {
          setOpen((o) => !o);
          // Telegram-like: the panel replaces the keyboard
          (document.activeElement as HTMLElement | null)?.blur?.();
        }}
        aria-label={open ? "Close stickers" : "Stickers"}
        aria-expanded={open}
        data-testid="sticker-button"
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full text-zinc-400 transition hover:bg-white/5 hover:text-zinc-100 disabled:opacity-40",
          compact ? "h-[38px] w-[38px]" : "h-[42px] w-[42px]",
          open && "bg-white/10 text-emerald-400",
        )}
      >
        <StickerIcon className="h-[22px] w-[22px]" />
      </button>
      {open && <StickerPanel onPick={pick} onClose={close} />}
    </div>
  );
}
