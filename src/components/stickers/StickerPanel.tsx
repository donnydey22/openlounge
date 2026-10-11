"use client";
// The sticker panel that opens above the composer (next to the emoji picker): search, Recent, Favorites and every
// pack in My stickers, with a Telegram-style tab strip of pack covers. Tap = send. Long-press / right-click = big
// preview with Favorite. "+" opens the store sheet without leaving the chat.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, Plus, Search, Star, X } from "lucide-react";
import { StickerView } from "./StickerView";
import { PackSheet } from "./PackSheet";
import { StoreSheet } from "./StickerStore";
import { Portal } from "./Portal";
import { api, isFavorite, loadCatalog, loadMine, loadPack, noteRecent, setFavorite, useStickers } from "@/lib/stickers/client";
import type { Sticker, StickerPack } from "@/lib/stickers/types";
import { cn } from "@/lib/utils";

type Pick = (packId: string, s: Sticker) => void;
const CELL = 68;
// scoped motion (transform/opacity only); reduced motion → simple fade
const PANEL_CSS = `
@keyframes ol-stk-in{from{opacity:0;transform:translateY(10px) scale(.98)}to{opacity:1;transform:none}}
@keyframes ol-stk-pop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.06);opacity:1}100%{transform:scale(1)}}
.ol-sticker-panel{animation:ol-stk-in .22s cubic-bezier(.22,1,.36,1);transform-origin:bottom center}
.ol-sticker-pop{animation:ol-stk-pop .28s cubic-bezier(.34,1.56,.64,1)}
@media (prefers-reduced-motion:reduce){.ol-sticker-panel,.ol-sticker-pop{animation:fade-in .15s linear}}`;

export function StickerPanel({ onPick, onClose }: { onPick: Pick; onClose: () => void }) {
  const catalog = useStickers((s) => s.catalog);
  const mine = useStickers((s) => s.mine);
  const packs = useStickers((s) => s.packs);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ packId: string; sticker: Sticker }[] | null>(null);
  const [preview, setPreview] = useState<{ packId: string; sticker: Sticker } | null>(null);
  const [sheetPack, setSheetPack] = useState<string | null>(null);
  const [storeOpen, setStoreOpen] = useState(false);
  const [active, setActive] = useState<string>("recent");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadCatalog();
    void loadMine();
  }, []);

  // Packs shown: My stickers; before anything is added, every free featured pack so stickers work instantly.
  const packIds = useMemo(() => {
    if (mine?.added.length) return mine.added;
    return (catalog?.packs ?? []).filter((p) => !p.priceCents).map((p) => p.id);
  }, [mine?.added, catalog]);
  const featured = !mine?.added.length;

  useEffect(() => {
    packIds.forEach((id) => void loadPack(id));
    mine?.recents.concat(mine.favorites).forEach((r) => void loadPack(r.packId));
  }, [packIds, mine]);

  // search (debounced): server-side keyword/emoji search across all published packs
  useEffect(() => {
    const n = q.trim();
    if (!n) return setResults(null);
    const t = setTimeout(() => {
      api<{ results: { packId: string; sticker: Sticker }[] }>(`/search?q=${encodeURIComponent(n)}`, { auth: false })
        .then((r) => setResults(r.results))
        .catch(() => setResults([]));
    }, 150);
    return () => clearTimeout(t);
  }, [q]);

  const resolve = useCallback((refs: { packId: string; stickerId: string }[]) => refs.map((r) => ({ packId: r.packId, sticker: packs[r.packId]?.stickers.find((s) => s.id === r.stickerId) })).filter((x): x is { packId: string; sticker: Sticker } => !!x.sticker), [packs]);
  const recents = useMemo(() => resolve(mine?.recents ?? []).slice(0, 16), [mine?.recents, resolve]);
  const favorites = useMemo(() => resolve(mine?.favorites ?? []), [mine?.favorites, resolve]);

  const send = useCallback<Pick>(
    (packId, s) => {
      noteRecent(packId, s.id);
      onPick(packId, s);
    },
    [onPick],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (preview) setPreview(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, preview]);

  const jump = (id: string) => {
    setActive(id);
    const el = scroller.current?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (el && scroller.current) scroller.current.scrollTo({ top: el.offsetTop - 4, behavior: "smooth" });
  };
  // keep the active tab in sync while scrolling
  const onScroll = () => {
    const sc = scroller.current;
    if (!sc) return;
    const secs = sc.querySelectorAll<HTMLElement>("[data-section]");
    let cur = active;
    for (const s of secs) if (s.offsetTop - sc.scrollTop <= 24) cur = s.dataset.section!;
    if (cur !== active) setActive(cur);
  };

  return (
    <div
      className="ol-sticker-panel absolute inset-x-0 bottom-full z-40 mb-2 flex h-[min(360px,52dvh)] flex-col overflow-hidden rounded-3xl border border-white/10 bg-zinc-900/95 shadow-2xl backdrop-blur-xl"
      data-testid="sticker-panel"
      role="dialog"
      aria-label="Stickers"
    >
      <style>{PANEL_CSS}</style>
      <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search stickers"
            enterKeyHint="search"
            data-testid="sticker-search"
            className="h-9 w-full rounded-full bg-white/5 pr-8 pl-9 text-[16px] outline-none placeholder:text-zinc-500 focus:bg-white/10 sm:text-sm"
          />
          {q && (
            <button type="button" onClick={() => setQ("")} className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1 text-zinc-500 hover:text-zinc-200" aria-label="Clear search">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <button type="button" onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-zinc-400 hover:bg-white/5 hover:text-white" aria-label="Close stickers">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2 [scrollbar-width:thin]" data-testid="sticker-scroll">
        {results ? (
          results.length ? (
            <Grid items={results} onSend={send} onPreview={setPreview} />
          ) : (
            <p className="py-10 text-center text-sm text-zinc-500">No stickers match “{q}”.</p>
          )
        ) : (
          <>
            {recents.length > 0 && (
              <Section id="recent" title="Recent">
                <Grid items={recents} onSend={send} onPreview={setPreview} />
              </Section>
            )}
            {favorites.length > 0 && (
              <Section id="favorites" title="Favorites">
                <Grid items={favorites} onSend={send} onPreview={setPreview} />
              </Section>
            )}
            {packIds.map((id) => {
              const p = packs[id];
              return (
                <Section key={id} id={id} title={p?.title ?? "…"} action={featured ? <button type="button" onClick={() => setSheetPack(id)} className="rounded-full px-2 py-0.5 text-[11px] font-semibold text-emerald-400 hover:bg-emerald-500/10">Add</button> : undefined}>
                  {p ? <Grid items={p.stickers.map((s) => ({ packId: id, sticker: s }))} onSend={send} onPreview={setPreview} /> : <div style={{ height: CELL * 2 }} />}
                </Section>
              );
            })}
            {packIds.length === 0 && catalog && <p className="py-10 text-center text-sm text-zinc-500">Add sticker packs from the store.</p>}
          </>
        )}
      </div>

      <nav className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-white/5 px-2 py-1.5 [scrollbar-width:none]" aria-label="Sticker packs">
        <button type="button" onClick={() => setStoreOpen(true)} className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-zinc-400 hover:bg-white/5 hover:text-white" aria-label="Browse sticker store" data-testid="sticker-store-open">
          <Plus className="h-5 w-5" />
        </button>
        {recents.length > 0 && <Tab active={active === "recent"} onClick={() => jump("recent")} label="Recent"><Clock className="h-5 w-5" /></Tab>}
        {favorites.length > 0 && <Tab active={active === "favorites"} onClick={() => jump("favorites")} label="Favorites"><Star className="h-5 w-5" /></Tab>}
        {packIds.map((id) => {
          const p = packs[id];
          const cover = p?.stickers.find((s) => s.id === p.cover) ?? p?.stickers[0];
          return (
            <Tab key={id} active={active === id} onClick={() => jump(id)} label={p?.title ?? "Pack"}>
              {cover ? <StickerView sticker={cover} size={30} animate={false} /> : <span className="h-[30px] w-[30px]" />}
            </Tab>
          );
        })}
      </nav>

      {preview && <Preview item={preview} onClose={() => setPreview(null)} onSend={send} onOpenPack={(id) => { setPreview(null); setSheetPack(id); }} />}
      <Portal>
        <PackSheet packId={sheetPack} open={!!sheetPack} onClose={() => setSheetPack(null)} onSend={send} />
      </Portal>
      <StoreSheet open={storeOpen} onClose={() => setStoreOpen(false)} onSend={send} />
    </div>
  );
}

function Section({ id, title, action, children }: { id: string; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section data-section={id} className="pt-1">
      <h3 className="flex items-center justify-between px-1.5 pt-1 pb-1 text-[12px] font-semibold tracking-wide text-zinc-500 uppercase">
        <span className="truncate">{title}</span>
        {action}
      </h3>
      {children}
    </section>
  );
}

function Tab({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} aria-current={active || undefined} className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-xl text-zinc-400 transition-colors", active ? "bg-white/10 text-white" : "hover:bg-white/5")}>
      {children}
    </button>
  );
}

const Grid = memo(function Grid({ items, onSend, onPreview }: { items: { packId: string; sticker: Sticker }[]; onSend: Pick; onPreview: (x: { packId: string; sticker: Sticker }) => void }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] justify-items-center [content-visibility:auto] [contain-intrinsic-size:auto_160px]">
      {items.map((it) => (
        <Cell key={`${it.packId}/${it.sticker.id}`} item={it} onSend={onSend} onPreview={onPreview} />
      ))}
    </div>
  );
});

function Cell({ item, onSend, onPreview }: { item: { packId: string; sticker: Sticker }; onSend: Pick; onPreview: (x: { packId: string; sticker: Sticker }) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const long = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return (
    <button
      type="button"
      data-testid="sticker-cell"
      aria-label={`Send ${item.sticker.emoji} sticker`}
      className="rounded-2xl p-1 transition-transform duration-150 ease-out [touch-action:manipulation] [-webkit-touch-callout:none] hover:bg-white/5 active:scale-90"
      onPointerDown={(e) => {
        long.current = false;
        if (e.pointerType === "mouse") return;
        clear();
        timer.current = setTimeout(() => {
          long.current = true;
          navigator.vibrate?.(8);
          onPreview(item);
        }, 380);
      }}
      onPointerUp={clear}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onContextMenu={(e) => {
        e.preventDefault();
        clear();
        long.current = true;
        onPreview(item);
      }}
      onClick={() => {
        if (long.current) return;
        onSend(item.packId, item.sticker);
      }}
    >
      <StickerView sticker={item.sticker} size={60} still />
    </button>
  );
}

function Preview({ item, onClose, onSend, onOpenPack }: { item: { packId: string; sticker: Sticker }; onClose: () => void; onSend: Pick; onOpenPack: (id: string) => void }) {
  const mine = useStickers((s) => s.mine);
  const pack = useStickers((s) => s.packs[item.packId] as StickerPack | undefined);
  const fav = isFavorite(mine, item.packId, item.sticker.id);
  return (
    <div className="fade-in absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-zinc-950/85 backdrop-blur-md" onClick={onClose} data-testid="sticker-preview">
      <div className="ol-sticker-pop" onClick={(e) => e.stopPropagation()}>
        <StickerView sticker={item.sticker} size={180} />
      </div>
      <div className="text-2xl" aria-hidden>{item.sticker.emoji}</div>
      <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => { onSend(item.packId, item.sticker); onClose(); }} className="rounded-full bg-emerald-500 px-5 py-2 text-sm font-semibold text-on-accent">
          Send
        </button>
        <button type="button" onClick={() => void setFavorite(item.packId, item.sticker.id, !fav)} className="flex items-center gap-1.5 rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-zinc-100" data-testid="sticker-fav">
          <Star className={cn("h-4 w-4", fav && "fill-amber-300 text-amber-300")} /> {fav ? "Unfavorite" : "Favorite"}
        </button>
        <button type="button" onClick={() => onOpenPack(item.packId)} className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-zinc-100">
          {pack?.title ?? "Pack"}
        </button>
      </div>
    </div>
  );
}
