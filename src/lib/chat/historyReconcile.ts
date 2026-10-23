// Pure helpers for the cached chat history (render from cache instantly, then reconcile with the server).
// The server is the source of truth and keeps every message. The device cache keeps every message row it has ever
// loaded (never evicted; only media BYTES are evictable, see mediaCache.ts) and merges new pages into what it has.

export type CachedMsg = { id: string; createdAt: number; clientId?: string | null; state?: unknown };

/** page size for history requests (first page + every older page) */
export const HISTORY_PAGE = 40;
/** start fetching the next older page when the reader is this close to the top (px) */
export const PREFETCH_TOP_PX = 900;

const byTime = (a: CachedMsg, b: CachedMsg) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Reconcile the newest server page with what is on screen (cache and/or live): inside the page's time range the
 * server wins (a cached message missing there was deleted / hidden meanwhile); older cached messages stay until
 * their own page is fetched; optimistic (state) messages always stay, last. Returns a new oldest-first list.
 */
export function reconcileNewest<T extends CachedMsg>(current: readonly T[], page: readonly T[], pageHasMore: boolean): T[] {
  if (!page.length) {
    // the server has nothing (left / hidden / empty): keep only my unsent optimistic messages
    return pageHasMore ? current.filter((m) => !m.state) : current.filter((m) => !!m.state);
  }
  const from = page[0];
  const confirmed = current.filter((m) => !m.state);
  const pending = current.filter((m) => !!m.state);
  // hasMore=false: the page reaches #1. Otherwise older rows stay only if they connect to the page (an id overlaps):
  // a cache from before a long gap would leave a hole that "load earlier" (oldest-id cursor) would skip over.
  const connected = pageHasMore && confirmed.some((m) => page.some((p) => p.id === m.id));
  const older = connected ? confirmed.filter((m) => byTime(m, from) < 0) : [];
  const ids = new Set(page.map((m) => m.id));
  const cids = new Set(page.map((m) => m.clientId).filter(Boolean));
  const stillPending = pending.filter((m) => !(m.clientId && cids.has(m.clientId)) && !ids.has(m.id));
  return [...older.filter((m) => !ids.has(m.id)), ...page, ...stillPending];
}

/** Reconcile an older page: replace whatever we had in [page.first, page.last] with the server's copy. */
export function reconcileOlder<T extends CachedMsg>(current: readonly T[], page: readonly T[]): T[] {
  if (!page.length) return [...current];
  const first = page[0];
  const last = page[page.length - 1];
  const ids = new Set(page.map((m) => m.id));
  const outside = current.filter((m) => !ids.has(m.id) && (!!m.state || byTime(m, first) < 0 || byTime(m, last) > 0));
  const before = outside.filter((m) => !m.state && byTime(m, first) < 0);
  const after = outside.filter((m) => !before.includes(m));
  return [...before, ...page, ...after];
}

/** what goes into the device cache: confirmed messages only (optimistic ones live in the outbox / on screen) */
export function cacheWindow<T extends CachedMsg>(list: readonly T[]): T[] {
  return list.filter((m) => !m.state);
}

/**
 * Merge what a thread has loaded now into what the device cache already holds, so reopening a chat with only the
 * newest page loaded never shrinks a cache that had scrolled back further. Inside the incoming range the incoming
 * copy wins (edits / deletions); cached rows older than it are kept unless the incoming list reaches message #1.
 * If the incoming rows don't connect to the cached ones (a gap in between), `disconnected` is set: the caller sets the
 * old record aside (kept, not deleted) and starts a fresh one, so the cache never contains a silent hole.
 */
export function mergeForCache<T extends CachedMsg>(cached: readonly T[], cachedHasMore: boolean, incoming: readonly T[], incomingHasMore: boolean): { messages: T[]; hasMore: boolean; disconnected?: true } {
  const inc = cacheWindow(incoming);
  if (!inc.length) return { messages: [...cached], hasMore: cachedHasMore };
  const first = inc[0];
  const ids = new Set(inc.map((m) => m.id));
  const connected = cached.some((m) => ids.has(m.id));
  if (incomingHasMore && cached.length && !connected) return { messages: inc, hasMore: true, disconnected: true as const };
  const older = incomingHasMore ? cached.filter((m) => !ids.has(m.id) && byTime(m, first) < 0) : [];
  return { messages: [...older, ...inc], hasMore: older.length ? cachedHasMore : incomingHasMore };
}

/** Since-cursor top-up: append the server's newer messages after the cached newest (dedupe by id / clientId). */
export function appendNewer<T extends CachedMsg>(current: readonly T[], newer: readonly T[]): T[] {
  if (!newer.length) return [...current];
  const ids = new Set(newer.map((m) => m.id));
  const cids = new Set(newer.map((m) => m.clientId).filter(Boolean));
  const confirmed = current.filter((m) => !m.state && !ids.has(m.id));
  const pending = current.filter((m) => !!m.state && !(m.clientId && cids.has(m.clientId)));
  return [...confirmed, ...newer, ...pending].sort((a, b) => (a.state ? 1 : 0) - (b.state ? 1 : 0) || (a.state || b.state ? 0 : byTime(a, b)));
}

/** the newest server-confirmed message (the since-cursor) */
export function newestConfirmed<T extends CachedMsg>(list: readonly T[]): T | null {
  for (let i = list.length - 1; i >= 0; i--) if (!list[i].state && !String(list[i].id).startsWith("tmp")) return list[i];
  return null;
}
