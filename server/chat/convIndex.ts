// conversationId -> messages, plus a per-user index of the conversation keys they are part of, so the inbox, unread
// totals and reconnect catch-up touch only that user's chats instead of every conversation on the server.
// 1:1 keys are "a|b" (both users indexed); group keys ("g_…") are indexed by the group layer (byUser), not here.
import type { DirectMessage } from "../../src/lib/types";

export class ConversationMap extends Map<string, DirectMessage[]> {
  private byUser = new Map<string, Set<string>>();

  private index(key: string, add: boolean) {
    const i = key.indexOf("|");
    if (i < 0) return;
    for (const uid of [key.slice(0, i), key.slice(i + 1)]) {
      let s = this.byUser.get(uid);
      if (add) {
        if (!s) this.byUser.set(uid, (s = new Set()));
        s.add(key);
      } else if (s) {
        s.delete(key);
        if (!s.size) this.byUser.delete(uid);
      }
    }
  }

  override set(key: string, value: DirectMessage[]) {
    // Map's constructor calls set() before our field initializers ran
    if (this.byUser && !super.has(key)) this.index(key, true);
    return super.set(key, value);
  }

  override delete(key: string) {
    const had = super.delete(key);
    if (had) this.index(key, false);
    return had;
  }

  override clear() {
    super.clear();
    this.byUser.clear();
  }

  /** 1:1 conversation keys this user is part of */
  keysOf(userId: string): readonly string[] {
    return [...(this.byUser.get(userId) ?? [])];
  }
}
