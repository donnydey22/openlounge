// Offline launch (WhatsApp-style): the last signed-in profile snapshot lets the app open straight into the inbox
// with no signal. Never a credential — only the profile the server already sent (name, colour, photo url…).
// Bound to the stored credentials' uid: a snapshot for a different account is never used (account switch / shared
// device), and it is wiped with every other per-user cache on sign-out.
export type OfflineSnap<M extends { id: string }> = { v: 1; me: M; following: string[]; unreadDms: number; savedAt: number };
const KEY = "ol-offline-me";

type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const ls = (): KV | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function saveOfflineMe<M extends { id: string }>(me: M, following: Iterable<string>, unreadDms: number, kv: KV | null = ls()) {
  try {
    kv?.setItem(KEY, JSON.stringify({ v: 1, me, following: [...following], unreadDms, savedAt: Date.now() } satisfies OfflineSnap<M>));
  } catch {
    /* quota / private mode */
  }
}

/** The snapshot only if it belongs to `uid` (the stored session's account); anything else is discarded. */
export function readOfflineMe<M extends { id: string }>(uid: string | null | undefined, kv: KV | null = ls()): OfflineSnap<M> | null {
  try {
    const raw = kv?.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as OfflineSnap<M>;
    if (s?.v !== 1 || typeof s.me?.id !== "string") return null;
    if (!uid || s.me.id !== uid) {
      kv?.removeItem(KEY); // another account's profile: never shown
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

/** id of whoever the snapshot belongs to (for account-switch detection), without validating against creds */
export function offlineMeId(kv: KV | null = ls()): string | null {
  try {
    const raw = kv?.getItem(KEY);
    return raw ? ((JSON.parse(raw) as OfflineSnap<{ id: string }>).me?.id ?? null) : null;
  } catch {
    return null;
  }
}

export function clearOfflineMe(kv: KV | null = ls()) {
  try {
    kv?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
