"use client";
import { formatPrice, isFree, type StickerPack, type PackSummary } from "@/lib/stickers/types";
import { useStickers } from "@/lib/stickers/client";

/** Small price chip on paid packs ("$0.99"), "Owned" once bought. Free packs show nothing (Telegram style). */
export function PriceChip({ pack, showFree }: { pack: Pick<StickerPack | PackSummary, "id" | "priceCents" | "currency" | "premium">; showFree?: boolean }) {
  const owned = useStickers((s) => !!s.mine?.owned.includes(pack.id));
  if (pack.premium)
    return (
      <span className="rounded-full bg-gradient-to-r from-violet-500/25 to-fuchsia-500/25 px-2 py-0.5 text-[11px] font-semibold text-fuchsia-200" data-testid="premium-chip">
        ★ Premium
      </span>
    );
  if (isFree(pack)) return showFree ? <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-semibold text-zinc-400">Free</span> : null;
  if (owned) return <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-400">Owned</span>;
  return (
    <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300" data-testid="price-chip">
      {formatPrice(pack.priceCents!, pack.currency)}
    </span>
  );
}
