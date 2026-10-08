"use client";

// In-chat search (one DM or group), Telegram-style: a bar slides in over the chat header; filter by words, #tag,
// @mention and a "from:" member; results newest first with ▲/▼ and "N of M"; tapping one jumps to the message,
// flashes it and highlights every match in the visible bubbles. Opened by tapping a #tag in a chat, Cmd/Ctrl+F on
// /messages/<id>, or openChatSearch() (chat header search button). "All chats" hands off to the main search.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown, ChevronUp, List, MessageSquare, Search, User, X } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { useApp } from "@/components/AppProvider";
import { normalizeTag } from "@/lib/linkify";
import { isEmptyQuery, parseSearchQuery } from "@/lib/searchQuery";
import { hxGet, searchUrl, useHx, type HxMember, type HxMessage, type HxResults } from "@/lib/searchClient";
import { cn } from "@/lib/utils";
import { HxMessageRow, ResultsSkeleton } from "./SearchResults";

const EVT = "openlounge:chat-search";
type OpenDetail = { chat: string | null; q?: string; list?: boolean };

function chatFromPath(path = typeof window === "undefined" ? "" : window.location.pathname): string | null {
  const m = path.match(/^\/messages\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Open the in-chat search for the current conversation (chat header button calls this with no args). */
export function openChatSearch(o: { q?: string; list?: boolean; chat?: string | null } = {}) {
  window.dispatchEvent(new CustomEvent<OpenDetail>(EVT, { detail: { chat: o.chat ?? chatFromPath(), q: o.q, list: o.list } }));
}

/** #tag tapped anywhere: in a chat → in-chat search for it; elsewhere (titles, bios) → main search. */
export function openHashtag(tag: string) {
  openChatSearch({ q: `#${normalizeTag(tag)}`, list: true });
}

// ---------- jump + highlight (works on whatever the chat renders; bubbles expose data-message-id) ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const threadRoot = () => (document.querySelector('[data-testid="dm-thread"]') as HTMLElement | null) ?? (document.querySelector("#app-scroll") as HTMLElement | null);

type JumpTarget = { id: string; text?: string; at?: number; chat?: { id: string } };

function findBubble(m: JumpTarget): HTMLElement | null {
  const id = CSS.escape(m.id);
  // the bubble itself (flash hugs its shape), else the row: DM + group threads mark each message row with data-mid
  // ([data-testid=dm-msg]; group service rows too)
  const byId =
    (document.querySelector(`[data-mid-bubble="${id}"]`) as HTMLElement | null) ??
    (document.querySelector(`[data-message-id="${id}"], [data-testid="dm-msg"][data-mid="${id}"], [data-testid="group-service"][data-mid="${id}"]`) as HTMLElement | null);
  if (byId) return byId;
  // fallback for renderers without message-id attributes: the smallest element whose text is exactly this message
  const root = threadRoot();
  if (!root || !m.text) return null;
  const want = m.text.replace(/…$/, "").trim().slice(0, 120);
  if (want.length < 2) return null;
  let best: HTMLElement | null = null;
  for (const el of root.querySelectorAll<HTMLElement>("p, div, span")) {
    const t = el.textContent?.trim() ?? "";
    if (t.startsWith(want) && t.length <= m.text.length + 40 && (!best || best.contains(el))) best = el;
  }
  return best;
}

/** The thread's own "Load earlier messages" control (DmThread renders it while older history exists). */
function loadEarlierButton(): HTMLButtonElement | null {
  const root = threadRoot();
  if (!root) return null;
  for (const b of root.querySelectorAll<HTMLButtonElement>("button")) if (/^(Load earlier messages|Loading…)$/.test(b.textContent?.trim() ?? "")) return b;
  return null;
}
/** Oldest message time currently rendered (bubbles carry data-ts), to stop paging once we're past the target. */
function oldestRendered(): number {
  let min = Infinity;
  for (const el of document.querySelectorAll<HTMLElement>("[data-ts]")) min = Math.min(min, Number(el.dataset.ts) || Infinity);
  return min;
}

/** Find the message in the open thread, paging older history in as needed (up to ~40 pages), then scroll + flash it. */
export async function jumpToMessage(m: JumpTarget, o: { pages?: number } = {}): Promise<boolean> {
  let el = findBubble(m);
  if (!el) {
    // let a renderer that supports it load history around the message; otherwise page back with its own control
    window.dispatchEvent(new CustomEvent("openlounge:load-message", { detail: { chat: m.chat?.id, id: m.id, at: m.at } }));
    for (let page = 0, idle = 0; !el && page < (o.pages ?? 40) && idle < 12; ) {
      await sleep(150);
      el = findBubble(m);
      if (el) break;
      const btn = loadEarlierButton();
      if (!btn) { idle++; continue; } // history fully loaded (or not rendered yet)
      if (m.at && oldestRendered() < m.at - 1000 && !btn.disabled && btn.textContent?.trim() !== "Loading…") {
        idle++; // we're already older than the target and it isn't here: it was deleted
        if (idle > 3) break;
        continue;
      }
      if (btn.textContent?.trim() === "Loading…") continue;
      btn.click();
      page++;
      idle = 0;
      for (let i = 0; i < 40 && loadEarlierButton()?.textContent?.trim() === "Loading…"; i++) await sleep(100);
    }
  }
  if (!el) return false;
  // the thread restores its scroll anchor a frame after older history lands; scroll after that, not into the race
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  const target = el;
  setTimeout(() => {
    // late layout shifts (images, header, pinned bar) can push it off-screen: settle it once more without animation
    const r = target.getBoundingClientRect();
    if (target.isConnected && (r.bottom < 0 || r.top > window.innerHeight)) target.scrollIntoView({ block: "center" });
  }, 700);
  el.classList.remove("ol-flash");
  void el.offsetWidth; // restart the animation
  el.classList.add("ol-flash");
  const flashed = el;
  setTimeout(() => flashed.classList.remove("ol-flash"), 2000);
  return true;
}

/** /messages/<chat>?m=<message id> (search results, shared links): once the thread renders, jump to that message. */
function useDeepLinkJump(pathname: string | null, toast: (message: string) => void) {
  useEffect(() => {
    const chat = chatFromPath(pathname ?? undefined);
    const id = chat ? new URLSearchParams(window.location.search).get("m") : null;
    if (!chat || !id) return;
    let cancelled = false;
    void (async () => {
      // wait for the thread's first history render (bubbles or the empty-state header), then let it pin to the bottom
      for (let i = 0; i < 80 && !cancelled && !document.querySelector("[data-mid-bubble], [data-ts]"); i++) await sleep(100);
      await sleep(250);
      if (cancelled) return;
      const ok = await jumpToMessage({ id, chat: { id: chat } });
      if (cancelled) return;
      const u = new URL(window.location.href);
      u.searchParams.delete("m"); // a reload or back/forward shouldn't jump again
      window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
      if (!ok) toast("That message is no longer available");
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per thread navigation
  }, [pathname]);
}

type HighlightCtor = new (...ranges: Range[]) => unknown;
function useBubbleHighlights(active: boolean, terms: string[]) {
  useEffect(() => {
    const H = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    if (!active || !terms.length || !H || !reg) return; // older engines: no in-bubble highlight (results still work)
    const needles = terms.map((t) => t.toLowerCase()).filter(Boolean);
    let raf = 0;
    const paint = () => {
      raf = 0;
      const root = threadRoot();
      if (!root) return;
      const ranges: Range[] = [];
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n && ranges.length < 400; n = walk.nextNode()) {
        const text = (n.nodeValue ?? "").toLowerCase();
        if (!text.trim()) continue;
        for (const needle of needles) {
          let i = text.indexOf(needle);
          while (i >= 0 && ranges.length < 400) {
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + needle.length);
            ranges.push(r);
            i = text.indexOf(needle, i + needle.length);
          }
        }
      }
      reg.set("ol-search", new H(...ranges));
    };
    paint();
    const mo = new MutationObserver(() => (raf ||= requestAnimationFrame(paint)));
    const root = threadRoot();
    if (root) mo.observe(root, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
      reg.delete("ol-search");
    };
  }, [active, terms]);
}

// ---------- the bar ----------
export function ChatSearchHost() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState<OpenDetail | null>(null);
  const [q, setQ] = useState("");
  const [from, setFrom] = useState<HxMember | null>(null);
  const [picker, setPicker] = useState(false);
  const [list, setList] = useState(true);
  const [idx, setIdx] = useState(0);
  const [more, setMore] = useState<HxMessage[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const { toast } = useApp();
  useDeepLinkJump(pathname, toast);

  // open requests
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<OpenDetail>).detail;
      if (!d.chat) {
        if (d.q) router.push(`/explore?q=${encodeURIComponent(d.q)}`);
        return;
      }
      setOpen(d);
      setQ(d.q ?? "");
      setFrom(null);
      setPicker(false);
      setList(d.list ?? true);
      setIdx(0);
      if (!d.q) requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, [router]);

  // Cmd/Ctrl+F inside a chat (web); Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f" && chatFromPath()) {
        e.preventDefault();
        if (open) input.current?.select();
        else openChatSearch();
      } else if (e.key === "Escape" && open) setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // leaving the chat closes the bar
  useEffect(() => {
    if (open && chatFromPath(pathname) !== open.chat) setOpen(null);
  }, [pathname, open]);

  const chat = open?.chat ?? null;
  const parsed = useMemo(() => parseSearchQuery(q), [q]);
  const searchable = !!chat && (!isEmptyQuery(parsed) || !!from);
  const url = searchable ? searchUrl({ q, scope: "chat", chat, from: from?.id }) : null;
  const { data, loading } = useHx<HxResults>(url, 200);
  useEffect(() => {
    setIdx(0);
    setMore([]);
    setNext(null);
  }, [url]);
  const results = useMemo(() => [...(data?.messages ?? []), ...more], [data, more]);
  const cursor = more.length ? next : (data?.next ?? null);
  const total = data?.total ?? results.length;

  const loadMore = useCallback(async () => {
    if (!cursor || !chat) return;
    const r = await hxGet<HxResults>(searchUrl({ q, scope: "chat", chat, from: from?.id, before: cursor }));
    if (r) {
      setMore((m) => [...m, ...r.messages]);
      setNext(r.next);
    }
  }, [cursor, chat, q, from]);

  const members = useHx<{ members: HxMember[] }>(open && picker && chat ? `/hx/members?chat=${encodeURIComponent(chat)}` : null, 0, 60_000);

  const terms = useMemo(() => [...parsed.words, ...parsed.tags.map((t) => `#${t}`), ...parsed.mentions.map((h) => `@${h}`)], [parsed]);
  useBubbleHighlights(!!open && !list, terms);

  const go = useCallback(
    (i: number) => {
      const m = results[i];
      if (!m) return;
      setIdx(i);
      setList(false);
      if (i >= results.length - 3) void loadMore();
      void jumpToMessage(m);
    },
    [results, loadMore],
  );

  if (!open) return null;
  const close = () => setOpen(null);
  const allChats = () => {
    const query = [q.trim()].filter(Boolean).join(" ");
    setOpen(null);
    router.push(query ? `/explore?q=${encodeURIComponent(query)}` : "/explore");
  };

  return (
    <div className="ol-vv-fixed pointer-events-none fixed inset-x-0 z-[60] flex flex-col" data-testid="chat-search">
      {/* top bar */}
      <div className="ol-slide-down pointer-events-auto border-b border-white/10 bg-app/95 pt-[env(safe-area-inset-top,0px)] backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-2xl items-center gap-1.5 px-2">
          <button type="button" onClick={close} aria-label="Close search" className="shrink-0 rounded-full p-2.5 text-zinc-300 hover:bg-white/5">
            <X className="h-5 w-5" />
          </button>
          <div className="relative flex min-w-0 flex-1 items-center rounded-full border border-white/10 bg-zinc-900 focus-within:border-emerald-500/60">
            <Search className="pointer-events-none ml-3 h-4 w-4 shrink-0 text-zinc-500" />
            {from && (
              <button
                type="button"
                onClick={() => setFrom(null)}
                className="ml-2 inline-flex max-w-[40%] shrink-0 items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300"
                aria-label={`Remove filter from ${from.name}`}
                data-testid="chat-search-from-chip"
              >
                <span className="truncate">from: {from.name}</span>
                <X className="h-3 w-3 shrink-0" />
              </button>
            )}
            <input
              ref={input}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  go(e.shiftKey ? Math.max(0, idx - 1) : results.length ? (list ? 0 : Math.min(results.length - 1, idx + 1)) : 0);
                }
              }}
              placeholder={from ? "Search their messages" : "Search this chat"}
              enterKeyHint="search"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Search this chat"
              className="min-w-0 flex-1 bg-transparent py-2 pr-3 pl-2 text-[15px] outline-none placeholder:text-zinc-600"
              data-testid="chat-search-input"
            />
          </div>
          <button
            type="button"
            onClick={() => setPicker((v) => !v)}
            aria-label="Filter by sender"
            aria-expanded={picker}
            className={cn("shrink-0 rounded-full p-2.5 hover:bg-white/5", picker || from ? "text-emerald-400" : "text-zinc-300")}
            data-testid="chat-search-from"
          >
            <User className="h-5 w-5" />
          </button>
        </div>
        <div className="mx-auto flex max-w-2xl items-center gap-2 px-3 pb-2 text-xs">
          <span className="rounded-full bg-white/10 px-2.5 py-1 font-medium text-white">This chat</span>
          <button type="button" onClick={allChats} className="rounded-full px-2.5 py-1 text-zinc-400 hover:bg-white/5" data-testid="chat-search-all">
            All chats
          </button>
        </div>
      </div>

      {/* sender picker */}
      {picker && (
        <div className="pointer-events-auto mx-auto w-full max-w-2xl px-2">
          <div className="mt-1 max-h-[40dvh] overflow-y-auto rounded-2xl border border-white/10 bg-zinc-900 p-1 shadow-xl" data-testid="chat-search-members">
            {!members.data ? (
              <ResultsSkeleton loading={members.loading} rows={2} />
            ) : (
              members.data.members.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => {
                    setFrom(u);
                    setPicker(false);
                    setList(true);
                  }}
                  className="flex w-full min-w-0 items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-white/5"
                >
                  <Avatar name={u.name} color={u.color} photo={u.photoUrl} size="xs" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {u.name} <span className="text-zinc-500">@{u.username}</span>
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* results list */}
      {list && searchable && !picker && (
        <div className="pointer-events-auto min-h-0 flex-1 overflow-y-auto bg-app/95 backdrop-blur-xl" data-testid="chat-search-results">
          <div className="mx-auto max-w-2xl px-2 pb-2">
            {!data ? (
              <ResultsSkeleton loading={loading} />
            ) : results.length === 0 ? (
              <p className="mt-8 text-center text-sm text-zinc-500">No messages found.</p>
            ) : (
              results.map((m, i) => (
                <HxMessageRow
                  key={m.id}
                  m={m}
                  query={parsed}
                  showChat={false}
                  active={i === idx}
                  onPick={(_, e) => {
                    e.preventDefault();
                    go(i);
                  }}
                />
              ))
            )}
            {cursor && list && results.length > 0 && (
              <button type="button" onClick={() => void loadMore()} className="mt-1 w-full rounded-2xl py-2.5 text-sm text-emerald-400 hover:bg-white/5">
                Show more
              </button>
            )}
          </div>
        </div>
      )}
      {!(list && searchable && !picker) && <div className="flex-1" />}

      {/* bottom navigator */}
      {searchable && (
        <div className="pointer-events-auto border-t border-white/10 bg-app/95 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur-xl">
          <div className="mx-auto flex h-12 max-w-2xl items-center gap-1 px-2">
            <button
              type="button"
              onClick={() => setList((v) => !v)}
              aria-label={list ? "Show in chat" : "Show as list"}
              className="shrink-0 rounded-full p-2.5 text-zinc-300 hover:bg-white/5"
              data-testid="chat-search-mode"
            >
              {list ? <MessageSquare className="h-5 w-5" /> : <List className="h-5 w-5" />}
            </button>
            <span className="min-w-0 flex-1 truncate text-center text-sm text-zinc-400 tabular-nums" aria-live="polite" data-testid="chat-search-count">
              {!data ? (loading ? "Searching…" : "") : results.length ? `${idx + 1} of ${total}` : "No results"}
            </span>
            <button type="button" onClick={() => go(idx + 1)} disabled={idx + 1 >= results.length} aria-label="Older match" className="shrink-0 rounded-full p-2.5 text-zinc-300 hover:bg-white/5 disabled:opacity-30" data-testid="chat-search-up">
              <ChevronUp className="h-5 w-5" />
            </button>
            <button type="button" onClick={() => go(idx - 1)} disabled={idx <= 0} aria-label="Newer match" className="shrink-0 rounded-full p-2.5 text-zinc-300 hover:bg-white/5 disabled:opacity-30" data-testid="chat-search-down">
              <ChevronDown className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
