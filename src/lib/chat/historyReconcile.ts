// Pure helpers for the cached chat history (render from cache instantly, then reconcile with the server).
// The server is the source of truth and keeps every message, so the device cache is only a window:
// trimming it never loses history — older pages are always re-fetchable with the dm:history cursor.

export type CachedMsg = { id: string; createdAt: number; clientId?: string | null; state?: unknown };

/** messages kept per thread in the device cache (the newest ones; older pages come back from the server) */
export const CACHE_THREAD_WINDOW = 400;
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
  const older = pageHasMore ? confirmed.filter((m) => byTime(m, from) < 0) : []; // hasMore=false: page reaches #1
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

/** what goes into the device cache: confirmed messages only, the newest CACHE_THREAD_WINDOW */
export function cacheWindow<T extends CachedMsg>(list: readonly T[]): T[] {
  const confirmed = list.filter((m) => !m.state);
  return confirmed.length > CACHE_THREAD_WINDOW ? confirmed.slice(-CACHE_THREAD_WINDOW) : confirmed;
}
