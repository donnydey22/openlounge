// Chat history paging shared by 1:1 and group conversations (Telegram/WhatsApp style: newest first, cursor = message id).
// Lists are kept oldest first (push order; load() sorts by createdAt), so a page is always a contiguous slice and two
// messages with the same createdAt can never be skipped or repeated across pages (the old timestamp-only cursor could).

export const HISTORY_PAGE_DEFAULT = 60; // legacy callers (no limit given) keep their page size
export const HISTORY_PAGE_MAX = 200;

export type PageQuery = { before?: number; beforeId?: string; limit?: number };

export function clampLimit(limit: unknown, fallback = HISTORY_PAGE_DEFAULT) {
  const n = Math.floor(Number(limit));
  return Number.isFinite(n) && n > 0 ? Math.min(n, HISTORY_PAGE_MAX) : fallback;
}

/** first index whose createdAt >= ts (binary search; list sorted by createdAt) */
function lowerBound<T extends { createdAt: number }>(list: readonly T[], ts: number) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].createdAt < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The `limit` messages right before the cursor (oldest first, as clients render them) + whether older ones exist.
 * beforeId wins when it is still in the list; an unknown id (deleted meanwhile) falls back to `before` (timestamp).
 */
export function pageBefore<T extends { id: string; createdAt: number }>(list: readonly T[], q: PageQuery = {}) {
  const limit = clampLimit(q.limit);
  let end = list.length;
  let found = false;
  if (typeof q.beforeId === "string" && q.beforeId) {
    for (let i = list.length - 1; i >= 0; i--)
      if (list[i].id === q.beforeId) {
        end = i;
        found = true;
        break;
      }
  }
  if (!found && typeof q.before === "number" && Number.isFinite(q.before) && q.before > 0) end = lowerBound(list, q.before);
  const start = Math.max(0, end - limit);
  return { messages: list.slice(start, end), hasMore: start > 0 };
}
