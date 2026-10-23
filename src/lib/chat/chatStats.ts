// Small client-side helpers for chat history: counters (cache hit rate, prefetch use — read by tests via
// window.__olChatStats) and the per-thread reading position ("reopen where you left off").

export const CACHE_FRESH_MS = 60_000; // a cached thread younger than this skips the background newest-page refresh
export const HISTORY_PAGE_MAX_CLIENT = 200; // since-cursor top-up size (server cap)

export const chatStats = { cacheHit: 0, cacheStale: 0, cacheMiss: 0, olderFromPrefetch: 0, olderFromNetwork: 0, olderMs: [] as number[], inboxCacheHit: 0, prefetchedThreads: 0 };
if (typeof window !== "undefined") (window as unknown as { __olChatStats: typeof chatStats }).__olChatStats = chatStats;

export type ReadPos = { id: string; offset: number; at: number };
const posKey = (meId: string, peerId: string) => `ol-chat-pos:${meId}:${peerId}`;

/** Remember the first visible message (null = at the bottom, the default). */
export function savePos(meId: string, peerId: string, pos: Omit<ReadPos, "at"> | null) {
  try {
    if (pos) localStorage.setItem(posKey(meId, peerId), JSON.stringify({ ...pos, at: Date.now() }));
    else localStorage.removeItem(posKey(meId, peerId));
  } catch {
    /* storage full / private mode: just reopen at the bottom */
  }
}

export function readPos(meId: string, peerId: string): ReadPos | null {
  try {
    const raw = localStorage.getItem(posKey(meId, peerId));
    const p = raw ? (JSON.parse(raw) as ReadPos) : null;
    return p && typeof p.id === "string" && typeof p.offset === "number" ? p : null;
  } catch {
    return null;
  }
}
