import type { ConversationSummary, DmReadStateEvent } from "@/lib/types";

/**
 * A read-state event emitted for the signed-in person came from another one of their
 * sessions. Apply its exact per-thread count; the independent `dm:unread` event keeps
 * header and native app-icon totals synchronized.
 */
export function applyOwnDirectReadState(
  conversations: ConversationSummary[] | null,
  selfId: string | undefined,
  state: DmReadStateEvent,
): ConversationSummary[] | null {
  if (!conversations || !selfId || state.peerId.startsWith("g_")) return conversations;
  let changed = false;
  const next = conversations.map((conversation) => {
    if (conversation.peer.id !== state.peerId || conversation.unread === state.unread) return conversation;
    changed = true;
    return { ...conversation, unread: state.unread };
  });
  return changed ? next : conversations;
}
