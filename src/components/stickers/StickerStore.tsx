"use client";
// Sticker store: search, category chips, featured packs with live previews, price chips on the (few) paid packs.
// Used as a full page (/stickers) and as a sheet from the chat panel.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Loader2, Plus, Search } from "lucide-react";
import { Sheet } from "@/components/Sheet";
import { useApp } from "@/components/AppProvider";
import { StickerView } from "./StickerView";
import { PriceChip } from "./PriceChip";
import { PackSheet } from "./PackSheet";
import { Portal } from "./Portal";
import { loadCatalog, loadMine, setAdded, useStickers } from "@/lib/stickers/client";
import { isFree, type PackSummary, type Sticker } from "@/lib/stickers/types";
import { cn } from "@/lib/utils";

export function StickerStore({ onSend, linkPacks }: { onSend?: (packId: string, s: Sticker) => void; linkPacks?: boolean }) {
  const catalog = useStickers((s) => s.catalog);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  useEffect(() => {
    void loadCatalog();
    void loadMine();
  }, []);
  const packs = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (catalog?.packs ?? []).filter(
      (p) => (!cat || p.category === cat) && (!n || p.title.toLowerCase().includes(n) || p.category.toLowerCase().includes(n) || p.description.toLowerCase().includes(n) || p.preview.some((s) => s.emoji === q.trim() || s.keywords.some((k) => k.includes(n)))),
    );
  }, [catalog, q, cat]);

  return (
    <div data-testid="sticker-store">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search sticker packs"
          enterKeyHint="search"
          className="w-full rounded-full border border-white/10 bg-zinc-900 py-2.5 pr-4 pl-11 text-[16px] outline-none placeholder:text-zinc-600 focus:border-emerald-500/60"
        />
      </div>
      <div className="-mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
        {[null, ...(catalog?.categories ?? [])].map((c) => (
          <button
            key={c ?? "all"}
            type="button"
            onClick={() => setCat(c)}
            className={cn("shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors", cat === c ? "bg-emerald-500 text-on-accent" : "bg-white/5 text-zinc-300 hover:bg-white/10")}
          >
            {c ?? "All"}
          </button>
        ))}
      </div>
      <div className="mt-3 divide-y divide-white/5">
        {!catalog && (
          <div className="grid h-32 place-items-center text-zinc-500">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}
        {packs.map((p) => (
          <PackRow key={p.id} pack={p} onOpen={() => setSheet(p.id)} href={linkPacks ? `/stickers/${p.id}` : undefined} />
        ))}
        {catalog && packs.length === 0 && <p className="py-10 text-center text-sm text-zinc-500">No packs match.</p>}
      </div>
      <Portal>
        <PackSheet packId={sheet} open={!!sheet} onClose={() => setSheet(null)} onSend={onSend} />
      </Portal>
    </div>
  );
}

function PackRow({ pack, onOpen, href }: { pack: PackSummary; onOpen: () => void; href?: string }) {
  const { me, toast } = useApp();
  const added = useStickers((s) => !!s.mine?.added.includes(pack.id));
  const [busy, setBusy] = useState(false);
  const body = (
    <>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate font-semibold text-zinc-100">{pack.title}</span>
        <PriceChip pack={pack} />
      </div>
      <div className="text-[13px] text-zinc-500">{pack.count} stickers · {pack.category}</div>
      <div className="mt-1.5 flex gap-1 overflow-hidden">
        {pack.preview.map((s) => (
          <StickerView key={s.id} sticker={s} size={52} still />
        ))}
      </div>
    </>
  );
  return (
    <div className="flex items-center gap-3 py-3" data-testid="pack-row">
      {href ? (
        <Link href={href} className="min-w-0 flex-1">
          {body}
        </Link>
      ) : (
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          {body}
        </button>
      )}
      {me && isFree(pack) ? (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await setAdded(pack.id, !added);
            } catch (e) {
              toast((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
          aria-label={added ? `Remove ${pack.title}` : `Add ${pack.title}`}
          data-testid={added ? "row-added" : "row-add"}
          className={cn("grid h-9 shrink-0 place-items-center rounded-full px-4 text-sm font-semibold transition active:scale-95", added ? "bg-white/5 text-zinc-400" : "bg-emerald-500 text-on-accent")}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : added ? <Check className="h-4 w-4" /> : <span className="flex items-center gap-1"><Plus className="h-4 w-4" />Add</span>}
        </button>
      ) : (
        <button type="button" onClick={onOpen} className="h-9 shrink-0 rounded-full bg-white/5 px-4 text-sm font-semibold text-zinc-200">
          View
        </button>
      )}
    </div>
  );
}

export function StoreSheet({ open, onClose, onSend }: { open: boolean; onClose: () => void; onSend?: (packId: string, s: Sticker) => void }) {
  return (
    <Portal>
      <Sheet open={open} onClose={onClose} title="Stickers">
        <div className="pb-4">
          <StickerStore onSend={onSend ? (id, s) => { onSend(id, s); onClose(); } : undefined} />
          <div className="mt-2 flex justify-between text-sm">
            <Link href="/stickers" className="text-zinc-400 hover:text-zinc-200">Open sticker store</Link>
            <Link href="/stickers/receipts" className="text-zinc-400 hover:text-zinc-200">Purchases</Link>
          </div>
        </div>
      </Sheet>
    </Portal>
  );
}
