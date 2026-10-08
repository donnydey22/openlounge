"use client";
// Telegram-style pack preview sheet: the whole pack animating in a grid, Add / Remove, a price chip and checkout for
// paid packs (web only), and attribution for openly licensed art.
import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, ExternalLink, Loader2, Plus, Trash2 } from "lucide-react";
import { Sheet } from "@/components/Sheet";
import { useApp } from "@/components/AppProvider";
import { StickerView } from "./StickerView";
import { PriceChip } from "./PriceChip";
import { PayButtons } from "./PayButtons";
import { inWrapper, loadConfig, loadMine, loadPack, setAdded, useStickers } from "@/lib/stickers/client";
import { isFree, type Sticker, type StickerPack } from "@/lib/stickers/types";
import { cn } from "@/lib/utils";

export function PackSheet({ packId, open, onClose, onSend }: { packId: string | null; open: boolean; onClose: () => void; onSend?: (packId: string, s: Sticker) => void }) {
  const pack = useStickers((s) => (packId ? s.packs[packId] ?? null : null));
  useEffect(() => {
    if (open && packId) {
      void loadPack(packId);
      void loadMine();
      void loadConfig();
    }
  }, [open, packId]);
  return (
    <Sheet open={open && !!packId} onClose={onClose} title={pack?.title ?? "Stickers"} footer={pack ? <PackActions pack={pack} onDone={onClose} /> : undefined}>
      {pack ? <PackBody pack={pack} onSend={onSend ? (s) => { onSend(pack.id, s); onClose(); } : undefined} /> : <div className="grid h-40 place-items-center text-zinc-500"><Loader2 className="h-5 w-5 animate-spin" /></div>}
    </Sheet>
  );
}

export function PackBody({ pack, onSend, size = 76 }: { pack: StickerPack; onSend?: (s: Sticker) => void; size?: number }) {
  return (
    <div data-testid="pack-body">
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
        <span>{pack.stickers.length} stickers</span>
        <span aria-hidden>·</span>
        <span>{pack.category}</span>
        <PriceChip pack={pack} />
      </div>
      {pack.description && <p className="mb-3 text-[15px] text-zinc-300">{pack.description}</p>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(80px,1fr))] justify-items-center gap-1 pb-2">
        {pack.stickers.map((s) => (
          <button
            key={s.id}
            type="button"
            disabled={!onSend}
            onClick={() => onSend?.(s)}
            className={cn("rounded-2xl p-1 transition-transform duration-150 ease-out active:scale-90", onSend && "hover:bg-white/5")}
            aria-label={onSend ? `Send ${s.emoji} sticker` : `${s.emoji} sticker`}
          >
            <StickerView sticker={s} size={size} />
          </button>
        ))}
      </div>
      {pack.attribution && (
        <p className="mt-2 rounded-2xl bg-white/[0.03] px-3 py-2.5 text-[12px] leading-relaxed text-zinc-500" data-testid="pack-attribution">
          {pack.attribution.text}{" "}
          {pack.attribution.source && (
            <a href={pack.attribution.source} target="_blank" rel="noopener noreferrer" className="text-zinc-400 underline underline-offset-2">
              Source
            </a>
          )}
          {pack.attribution.licenseUrl && (
            <>
              {" · "}
              <a href={pack.attribution.licenseUrl} target="_blank" rel="noopener noreferrer license" className="text-zinc-400 underline underline-offset-2">
                {pack.attribution.license}
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

export function PackActions({ pack, onDone }: { pack: StickerPack; onDone?: () => void }) {
  const { toast, me } = useApp();
  const mine = useStickers((s) => s.mine);
  const config = useStickers((s) => s.config);
  const [busy, setBusy] = useState(false);
  const owned = isFree(pack) || !!mine?.owned.includes(pack.id);
  const added = !!mine?.added.includes(pack.id);

  if (!me)
    return (
      <Link href="/" className="flex h-12 w-full items-center justify-center rounded-full bg-emerald-500 font-semibold text-on-accent">
        Sign in to add stickers
      </Link>
    );

  if (!owned && pack.premium)
    return inWrapper() ? (
      <p className="py-2 text-center text-sm text-zinc-400" data-testid="premium-pack-note">Included with Open Lounge Premium.</p>
    ) : (
      <Link href="/premium" className="flex h-12 w-full items-center justify-center rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 font-semibold text-white" data-testid="premium-pack-cta">
        ★ Included with Open Lounge Premium
      </Link>
    );
  if (!owned) {
    if (inWrapper())
      // App Store 3.1.1 / Google Play Payments: no in-app purchase flow in the store builds (see STORE_RULES.md)
      return <p className="py-2 text-center text-sm text-zinc-400" data-testid="wrapper-paid-note">This pack isn&apos;t available in the app yet.</p>;
    if (!config?.paidEnabled) return <p className="py-2 text-center text-sm text-zinc-400" data-testid="paid-soon">Paid packs are coming soon.</p>;
    return <PayButtons pack={pack} onPaid={() => { toast(`${pack.title} added to My stickers`); onDone?.(); }} />;
  }
  return (
    <button
      type="button"
      disabled={busy}
      data-testid={added ? "pack-remove" : "pack-add"}
      onClick={async () => {
        setBusy(true);
        try {
          await setAdded(pack.id, !added);
          toast(added ? `Removed ${pack.title}` : `${pack.title} added to My stickers`);
        } catch (e) {
          toast((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
      className={cn(
        "flex h-12 w-full items-center justify-center gap-2 rounded-full font-semibold transition active:scale-[0.98]",
        added ? "bg-white/5 text-red-400 hover:bg-white/10" : "bg-emerald-500 text-on-accent hover:bg-emerald-400",
      )}
    >
      {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : added ? <Trash2 className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
      {added ? "Remove from My stickers" : `Add ${pack.stickers.length} stickers`}
    </button>
  );
}

export function PackLink({ id }: { id: string }) {
  return (
    <Link href={`/stickers/${id}`} className="inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
      Open pack page <ExternalLink className="h-3.5 w-3.5" />
    </Link>
  );
}

export function AddedCheck() {
  return <Check className="h-4 w-4 text-emerald-400" />;
}
