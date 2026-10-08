"use client";

// Full animated emoji picker, two tabs:
//   Emoji  — Recent + 9 categories + search over every emoji we have an animation for (Telegram's set, plus Google Noto for
//            what Telegram lacks — or the reverse when the internal switch says Noto).
//   Google — all ~880 Google Noto Animated Emoji (CC BY 4.0) in Google's own categories, searchable by name + Google's tags,
//            each marked as animated; emoji Google never animated follow in a separate "More (static)" section.
// Grid cells show light posters and animate on hover / press. Sections use content-visibility so only what's on
// screen is laid out and painted; posters are lazy-loaded.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { AnimatedEmoji } from "./AnimatedEmoji";
import { cn } from "@/lib/utils";

type Row = [emoji: string, key: string, name: string, cat: number, durationMs: number, source: "t" | "n"];
type Catalog = { cats: string[]; rows: Row[] };
let catalogP: Promise<Catalog> | null = null;
export const loadCatalog = () => (catalogP ??= import("@/lib/emoji/catalog.json").then((m) => (m.default ?? m) as unknown as Catalog));
type GRow = [emoji: string, key: string, name: string, cat: number, tags: string];
type GCatalog = { cats: string[]; rows: GRow[] };
let googleP: Promise<GCatalog> | null = null;
const loadGoogle = () => (googleP ??= import("@/lib/emoji/google.json").then((m) => (m.default ?? m) as unknown as GCatalog));
const G_ICON = ["😀", "🙋", "🐻", "🍔", "✈️", "🎉", "💡", "❤️", "🏁", "⋯"];
const TAB_KEY = "ol:emojiTab";

const CAT_ICON = ["😀", "👋", "🐻", "🍔", "⚽", "✈️", "💡", "❤️", "🏳️"];
const CAT_LABEL = ["Smileys", "People", "Animals & Nature", "Food & Drink", "Activity", "Travel & Places", "Objects", "Symbols", "Flags"];
const RECENT_KEY = "ol:emojiRecent";

export function recentEmoji(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").slice(0, 24);
  } catch {
    return [];
  }
}
export function pushRecent(e: string) {
  try {
    const list = [e, ...recentEmoji().filter((x) => x !== e)].slice(0, 24);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

const Cell = memo(function Cell({
  e,
  name,
  size,
  onPick,
  source,
  kind,
}: {
  e: string;
  name: string;
  size: number;
  onPick: (e: string) => void;
  source?: "noto";
  /** Google tab: "animated" gets a small play marker, "static" shows the still glyph */
  kind?: "animated" | "static";
}) {
  return (
    <button
      type="button"
      title={kind ? `${name} — ${kind === "animated" ? "animated" : "static"}` : name}
      aria-label={name}
      data-emoji={e}
      data-kind={kind}
      onClick={() => onPick(e)}
      className="relative flex aspect-square items-center justify-center rounded-xl transition-transform duration-150 hover:bg-white/[0.06] active:scale-90 motion-reduce:transition-none"
    >
      {kind === "static" ? (
        <span className="leading-none" style={{ fontSize: Math.round(size * 0.82) }} aria-hidden>
          {e}
        </span>
      ) : (
        <AnimatedEmoji emoji={e} size={size} mode="hover" source={source} />
      )}
      {kind === "animated" && (
        <span aria-hidden className="pointer-events-none absolute right-0.5 bottom-0.5 h-0 w-0 border-y-[3px] border-l-[5px] border-y-transparent border-l-emerald-400/90" />
      )}
    </button>
  );
});

export function EmojiPicker({
  onPick,
  className,
  height = 320,
  autoFocusSearch,
  cellSize = 30,
}: {
  onPick: (emoji: string) => void;
  className?: string;
  height?: number;
  autoFocusSearch?: boolean;
  cellSize?: number;
}) {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [gcat, setGcat] = useState<GCatalog | null>(null);
  const [tab, setTabState] = useState<"emoji" | "google">("emoji");
  const [q, setQ] = useState("");
  const [active, setActive] = useState(-1);
  const [recent, setRecent] = useState<string[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const sections = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    let alive = true;
    loadCatalog().then((c) => alive && setCat(c));
    setRecent(recentEmoji());
    try {
      if (localStorage.getItem(TAB_KEY) === "google") setTabState("google");
    } catch {
      /* ignore */
    }
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (tab !== "google" || gcat) return;
    let alive = true;
    loadGoogle().then((g) => alive && setGcat(g));
    return () => {
      alive = false;
    };
  }, [tab, gcat]);
  const setTab = (t: "emoji" | "google") => {
    setTabState(t);
    setActive(-1);
    sections.current = [];
    scroller.current?.scrollTo({ top: 0 });
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      /* ignore */
    }
  };

  const pick = (e: string) => {
    pushRecent(e);
    setRecent(recentEmoji());
    onPick(e);
  };

  const byCat = useMemo(() => {
    if (!cat) return [];
    const out: Row[][] = cat.cats.map(() => []);
    for (const r of cat.rows) out[r[3]]?.push(r);
    return out;
  }, [cat]);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (tab !== "emoji" || !cat || !s) return null;
    const words = s.split(/\s+/);
    return cat.rows.filter((r) => r[0] === s || words.every((w) => r[2].includes(w))).slice(0, 160);
  }, [q, cat, tab]);
  // Google tab: animated sections (Google's categories) + "More (static)" = catalog emoji Google never animated
  const gByCat = useMemo(() => {
    if (!gcat) return [];
    const out: GRow[][] = gcat.cats.map(() => []);
    for (const r of gcat.rows) out[r[3]]?.push(r);
    return out;
  }, [gcat]);
  const gStatic = useMemo(() => {
    if (!gcat || !cat) return [];
    const animated = new Set(gcat.rows.map((r) => r[1]));
    return cat.rows.filter((r) => !animated.has(r[1]));
  }, [gcat, cat]);
  const gResults = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (tab !== "google" || !gcat || !s) return null;
    const words = s.split(/\s+/);
    const hit = (name: string, tags = "") => words.every((w) => name.includes(w) || tags.includes(w));
    return {
      animated: gcat.rows.filter((r) => r[0] === s || hit(r[2], r[4])).slice(0, 200),
      stat: gStatic.filter((r) => r[0] === s || hit(r[2])).slice(0, 80),
    };
  }, [q, gcat, gStatic, tab]);
  const searching = tab === "emoji" ? !!results : !!gResults;

  // highlight the tab of the section in view
  useEffect(() => {
    const root = scroller.current;
    if (!root || !cat || searching) return;
    const onScroll = () => {
      const top = root.scrollTop + 8;
      let idx = -1;
      sections.current.forEach((el, i) => {
        if (el && el.offsetTop <= top) idx = i;
      });
      setActive(idx);
    };
    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [cat, gcat, searching, tab]);

  const jump = (i: number) => {
    setQ("");
    requestAnimationFrame(() => {
      const el = i < 0 ? sections.current[0]?.previousElementSibling ?? null : sections.current[i];
      const root = scroller.current;
      if (root) root.scrollTo({ top: i < 0 ? 0 : (el as HTMLElement | null)?.offsetTop ?? 0, behavior: "smooth" });
    });
  };

  const grid = "grid grid-cols-[repeat(auto-fill,minmax(42px,1fr))] gap-0.5 px-2";
  // short panels (landscape phones, keyboard-sized): tabs + search share one row so the grid keeps its space
  const compact = height < 250;
  return (
    <div className={cn("flex flex-col overflow-hidden", className)} style={{ height }} data-testid="emoji-picker" data-compact={compact || undefined}>
      <div className={compact ? "flex min-w-0 items-center" : "contents"}>
      <div className={cn("flex shrink-0 items-center gap-1", compact ? "pt-1.5 pl-2" : "px-3 pt-2")} role="tablist" aria-label="Emoji sets">
        {(
          [
            ["emoji", "Emoji"],
            ["google", "Google"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            data-testid={`emoji-tab-${k}`}
            onClick={() => setTab(k)}
            className={cn(
              "flex h-8 items-center rounded-full px-3 text-xs font-semibold transition-colors",
              tab === k ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-300",
            )}
          >
            {label}
            {k === "google" && !compact && <span className="ml-1 font-normal text-emerald-400/90">animated</span>}
          </button>
        ))}
      </div>
      <div className={cn("flex min-w-0 items-center gap-2 pt-1.5 pb-1.5", compact ? "flex-1 pr-3 pl-1" : "px-3")}>
        <label className="flex h-9 flex-1 items-center gap-2 rounded-full bg-white/[0.06] px-3 text-zinc-400 focus-within:ring-1 focus-within:ring-emerald-500/50">
          <Search className="h-4 w-4 shrink-0" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus={autoFocusSearch}
            placeholder={compact ? "Search" : tab === "google" ? "Search Google animated emoji" : "Search emoji"}
            enterKeyHint="search"
            className="min-w-0 flex-1 bg-transparent text-[16px] text-zinc-100 outline-none placeholder:text-zinc-500 sm:text-sm"
            data-testid="emoji-search"
          />
          {q && (
            <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="rounded-full p-0.5 hover:text-zinc-200">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </label>
      </div>
      </div>
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2 [scrollbar-width:thin]">
        {tab === "google" ? (
          !gcat || !cat ? (
            <div className={cn(grid, "pt-2")}>
              {Array.from({ length: 32 }, (_, i) => (
                <div key={i} className="m-1.5 aspect-square animate-pulse rounded-full bg-white/[0.05]" />
              ))}
            </div>
          ) : gResults ? (
            gResults.animated.length || gResults.stat.length ? (
              <div data-testid="emoji-results">
                {gResults.animated.length > 0 && (
                  <>
                    <GHead label="Animated" count={gResults.animated.length} animated />
                    <div className={grid}>
                      {gResults.animated.map((r) => (
                        <Cell key={r[1]} e={r[0]} name={r[2]} size={cellSize} onPick={pick} source="noto" kind="animated" />
                      ))}
                    </div>
                  </>
                )}
                {gResults.stat.length > 0 && (
                  <>
                    <GHead label="More (static)" count={gResults.stat.length} />
                    <div className={grid}>
                      {gResults.stat.map((r) => (
                        <Cell key={r[1]} e={r[0]} name={r[2]} size={cellSize} onPick={pick} kind="static" />
                      ))}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <p className="px-4 py-10 text-center text-sm text-zinc-500">No emoji found</p>
            )
          ) : (
            <div data-testid="google-emoji">
              <p className="px-4 pt-2 text-[11px] leading-snug text-zinc-500">
                {gcat.rows.length} animated emoji by Google ·{" "}
                <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer" className="underline">
                  CC BY 4.0
                </a>
              </p>
              {gByCat.map((rows, i) => (
                <section
                  key={i}
                  ref={(el) => {
                    sections.current[i] = el;
                  }}
                  data-google-cat={gcat.cats[i]}
                  className="[contain-intrinsic-size:auto_480px] [content-visibility:auto]"
                >
                  <GHead label={gcat.cats[i]} count={rows.length} animated />
                  <div className={grid}>
                    {rows.map((r) => (
                      <Cell key={r[1]} e={r[0]} name={r[2]} size={cellSize} onPick={pick} source="noto" kind="animated" />
                    ))}
                  </div>
                </section>
              ))}
              <section
                ref={(el) => {
                  sections.current[gByCat.length] = el;
                }}
                data-google-cat="static"
                className="[contain-intrinsic-size:auto_960px] [content-visibility:auto]"
              >
                <GHead label="More (static)" count={gStatic.length} />
                <p className="px-4 pb-1 text-[11px] text-zinc-500">Google didn&apos;t animate these.</p>
                <div className={grid}>
                  {gStatic.map((r) => (
                    <Cell key={r[1]} e={r[0]} name={r[2].split(" ").slice(0, 6).join(" ")} size={cellSize} onPick={pick} kind="static" />
                  ))}
                </div>
              </section>
            </div>
          )
        ) : !cat ? (
          <div className={cn(grid, "pt-2")}>
            {Array.from({ length: 32 }, (_, i) => (
              <div key={i} className="m-1.5 aspect-square animate-pulse rounded-full bg-white/[0.05]" />
            ))}
          </div>
        ) : results ? (
          results.length ? (
            <div className={cn(grid, "pt-1")} data-testid="emoji-results">
              {results.map((r) => (
                <Cell key={r[1]} e={r[0]} name={r[2].split(" ").slice(0, 6).join(" ")} size={cellSize} onPick={pick} />
              ))}
            </div>
          ) : (
            <p className="px-4 py-10 text-center text-sm text-zinc-500">No emoji found</p>
          )
        ) : (
          <>
            {recent.length > 0 && (
              <section>
                <h3 className="sticky top-0 z-[1] bg-inherit px-4 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">Recent</h3>
                <div className={grid}>
                  {recent.map((e) => (
                    <Cell key={e} e={e} name={e} size={cellSize} onPick={pick} />
                  ))}
                </div>
              </section>
            )}
            {byCat.map((rows, i) => (
              <section
                key={i}
                ref={(el) => {
                  sections.current[i] = el;
                }}
                className="[contain-intrinsic-size:auto_480px] [content-visibility:auto]"
              >
                <h3 className="px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">{CAT_LABEL[i]}</h3>
                <div className={grid}>
                  {rows.map((r) => (
                    <Cell key={r[1]} e={r[0]} name={r[2].split(" ").slice(0, 6).join(" ")} size={cellSize} onPick={pick} />
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
      <nav className="flex shrink-0 items-center justify-between gap-0.5 border-t border-white/5 px-2 py-1" aria-label="Emoji categories">
        {(tab === "google" ? G_ICON : CAT_ICON).map((ic, i) => (
          <button
            key={`${tab}${i}`}
            type="button"
            onClick={() => jump(i)}
            aria-label={tab === "google" ? (gcat?.cats[i] ?? "More (static)") : CAT_LABEL[i]}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full text-[17px] transition",
              tab === "google" && "h-8 w-auto max-w-8 min-w-0 flex-1 text-[15px]",
              active === i && !searching ? "bg-white/10" : "opacity-60 hover:opacity-100",
            )}
          >
            {ic}
          </button>
        ))}
      </nav>
    </div>
  );
}

function GHead({ label, count, animated }: { label: string; count: number; animated?: boolean }) {
  return (
    <h3 className="flex items-center gap-1.5 px-4 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
      {label}
      <span className="font-normal normal-case text-zinc-600">{count}</span>
      {animated ? (
        <span className="ml-auto rounded-full bg-emerald-500/10 px-1.5 py-px text-[10px] font-medium normal-case tracking-normal text-emerald-400">animated</span>
      ) : (
        <span className="ml-auto rounded-full bg-white/5 px-1.5 py-px text-[10px] font-medium normal-case tracking-normal text-zinc-500">static</span>
      )}
    </h3>
  );
}
