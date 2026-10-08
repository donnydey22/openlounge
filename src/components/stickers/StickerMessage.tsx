"use client";
// A sticker message in a chat: large, no bubble (Telegram style). Fixed-size box from the first frame, so the list
// never shifts while the pack loads. Tap opens the pack preview sheet.
import { memo, useEffect, useState } from "react";
import { StickerView } from "./StickerView";
import { PackSheet } from "./PackSheet";
import { Portal } from "./Portal";
import { loadPack, useStickers } from "@/lib/stickers/client";
import type { StickerRef } from "@/lib/stickers/token";
import { cn } from "@/lib/utils";

export const StickerMessage = memo(function StickerMessage({ sticker, size = 152, className, pending }: { sticker: StickerRef; size?: number; className?: string; pending?: boolean }) {
  const s = useStickers((st) => st.packs[sticker.packId]?.stickers.find((x) => x.id === sticker.stickerId) ?? null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void loadPack(sticker.packId);
  }, [sticker.packId]);
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={cn("msg-in block rounded-2xl transition-transform duration-150 active:scale-95", pending && "opacity-70", className)}
        style={{ width: size, height: size }}
        data-testid="sticker-msg"
        aria-label={`${sticker.emoji || ""} sticker`}
      >
        {s ? <StickerView sticker={s} size={size} /> : <span className="grid h-full w-full place-items-center" style={{ fontSize: size * 0.55, lineHeight: 1 }}>{sticker.emoji || "🙂"}</span>}
      </button>
      {open && (
        <Portal>
          <PackSheet packId={sticker.packId} open={open} onClose={() => setOpen(false)} />
        </Portal>
      )}
    </>
  );
});
