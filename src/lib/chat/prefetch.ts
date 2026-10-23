// Warm the device cache for the chats you are most likely to open next (top of the inbox), on app open and after
// every reconnect — so tapping one paints instantly from cache and only a tiny since-cursor top-up goes over the wire.
// Paced well inside the socket's rate limit; skipped on data saver / metered "2g" connections.
import type { ConversationSummary, DirectMessage } from "@/lib/types";
import { readThread, writeInbox, writeThread } from "./historyCache";
import { chatStats } from "./chatStats";
import { HISTORY_PAGE, newestConfirmed } from "./historyReconcile";

type Req = <T>(event: string, payload?: unknown, timeoutMs?: number) => Promise<T>;
export const PREFETCH_TOP_CHATS = 5;

function saveData() {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !!c?.saveData || c?.effectiveType === "slow-2g" || c?.effectiveType === "2g";
}

let running = false;
export async function prefetchTopChats(request: Req, meId: string, n = PREFETCH_TOP_CHATS) {
  if (running || typeof window === "undefined" || saveData()) return;
  running = true;
  try {
    const { conversations } = await request<{ conversations: ConversationSummary[] }>("dm:list");
    void writeInbox(meId, conversations);
    for (const c of conversations.slice(0, n)) {
      const peerId = c.peer.id;
      const rec = await readThread<DirectMessage & { state?: unknown }>(meId, peerId);
      const cur = rec ? newestConfirmed(rec.messages) : null;
      if (cur && cur.id === c.lastMessage?.id) continue; // already up to date
      type H = { messages: DirectMessage[]; hasMore: boolean; peer?: unknown; group?: unknown; newer?: boolean };
      const pace = () => new Promise((r) => setTimeout(r, 120));
      if (cur && rec) {
        // top up with the since-cursor (bounded); if it can't connect, a fresh newest page replaces the record (the
        // old one is set aside by writeThread, never dropped)
        let after = cur.id;
        let rows = [...rec.messages];
        let done = false;
        let meta: H | null = null;
        for (let i = 0; i < 5 && !done; i++) {
          await pace();
          const r = await request<H>("dm:history", { peerId, afterId: after, limit: 200 });
          meta = r;
          if (!r.newer) break;
          rows = [...rows, ...r.messages];
          if (!r.hasMore || !r.messages.length) done = true;
          else after = r.messages[r.messages.length - 1].id;
        }
        if (done) {
          await writeThread(meId, peerId, rows, { hasMore: rec.hasMore, peer: meta?.peer, group: meta?.group });
          chatStats.prefetchedThreads++;
          continue;
        }
      }
      await pace();
      const r = await request<H>("dm:history", { peerId, limit: HISTORY_PAGE });
      await writeThread(meId, peerId, r.messages, { hasMore: r.hasMore, peer: r.peer, group: r.group });
      chatStats.prefetchedThreads++;
    }
  } catch {
    /* best effort */
  } finally {
    running = false;
  }
}
