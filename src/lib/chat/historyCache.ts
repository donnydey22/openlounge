// Device cache for chats (web, and the iOS / Android apps through their WebView's IndexedDB):
// inbox rows + every message row each thread has loaded (merged, never evicted), so chats open instantly (offline too) and then reconcile.
// - Never the source of truth: everything here is re-fetchable from the server, which keeps all history.
// - A corrupt / unreadable / newer-schema database is set aside (left untouched under its own name) and a fresh one
//   is used; tabs learn about it over BroadcastChannel. Nothing is silently dropped.
// - Scoped per signed-in user; wiped on sign-out (shared devices).
// - Media bytes are not stored here (the browser HTTP cache / CDN handle those).
import { mergeForCache, type CachedMsg } from "./historyReconcile";

const SCHEMA = 1;
const BASE = "ol-chat";
const NAME_KEY = "ol-chat-db"; // localStorage: current database name (changes when one is set aside)
const CHANNEL = "ol-chat-cache";

type ThreadRec<M> = { key: string; schema: number; savedAt: number; messages: M[]; hasMore: boolean; peer?: unknown; group?: unknown };
type InboxRec<C> = { key: string; schema: number; savedAt: number; conversations: C[] };

let dbp: Promise<IDBDatabase | null> | null = null;
let channel: BroadcastChannel | null = null;

const hasIdb = () => typeof indexedDB !== "undefined" && indexedDB !== null;

function dbName() {
  try {
    return localStorage.getItem(NAME_KEY) || BASE;
  } catch {
    return BASE;
  }
}

function chan() {
  if (channel || typeof BroadcastChannel === "undefined") return channel;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (e) => {
    if (e.data?.type === "set-aside") dbp = null; // another tab switched databases: reopen by the new name
  };
  return channel;
}

/** Leave the current database as it is (for inspection / recovery) and switch every tab to a fresh one. */
function setAside(reason: string) {
  const old = dbName();
  const next = `${BASE}-${Date.now().toString(36)}`;
  try {
    localStorage.setItem(NAME_KEY, next);
    localStorage.setItem(`${NAME_KEY}-aside`, JSON.stringify({ name: old, reason, at: Date.now() }));
  } catch {
    /* private mode: stays in-memory only */
  }
  console.warn(`[chat-cache] set aside ${old} (${reason}); using ${next}`);
  chan()?.postMessage({ type: "set-aside" });
  dbp = null;
}

function open(): Promise<IDBDatabase | null> {
  if (!hasIdb()) return Promise.resolve(null);
  chan();
  if (dbp) return dbp;
  dbp = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(dbName(), SCHEMA);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("threads")) db.createObjectStore("threads", { keyPath: "key" });
      if (!db.objectStoreNames.contains("inbox")) db.createObjectStore("inbox", { keyPath: "key" });
    };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("threads") || !db.objectStoreNames.contains("inbox")) {
        db.close();
        setAside("missing stores");
        return resolve(open());
      }
      db.onversionchange = () => {
        db.close();
        dbp = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      // VersionError (a newer app wrote it) or a broken file: keep it, start fresh
      const name = req.error?.name ?? "error";
      setAside(name);
      resolve(name === "VersionError" || name === "UnknownError" || name === "InvalidStateError" ? open() : null);
    };
    req.onblocked = () => resolve(null);
  });
  return dbp;
}

function tx<T>(store: "threads" | "inbox", mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined);
        try {
          const t = db.transaction(store, mode);
          const r = run(t.objectStore(store));
          t.oncomplete = () => resolve(r ? (r.result as T) : undefined);
          t.onerror = t.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      }),
  );
}

const valid = (m: unknown): m is CachedMsg => !!m && typeof (m as CachedMsg).id === "string" && typeof (m as CachedMsg).createdAt === "number";

export async function readThread<M extends CachedMsg>(meId: string, peerId: string): Promise<ThreadRec<M> | null> {
  const rec = await tx<ThreadRec<M>>("threads", "readonly", (s) => s.get(`${meId}:${peerId}`));
  if (!rec) return null;
  if (rec.schema !== SCHEMA || !Array.isArray(rec.messages) || !rec.messages.every(valid)) {
    // unreadable record: ignore it (the server copy reloads); the database itself is fine
    return null;
  }
  return rec;
}

/** Merge-write (one transaction): never shrinks what the device already had; an unreadable record is set aside. */
export function writeThread<M extends CachedMsg>(meId: string, peerId: string, messages: readonly M[], extra: { hasMore: boolean; peer?: unknown; group?: unknown }) {
  const key = `${meId}:${peerId}`;
  return tx("threads", "readwrite", (s) => {
    const get = s.get(key);
    get.onsuccess = () => {
      const old = get.result as ThreadRec<M> | undefined;
      const ok = !!old && old.schema === SCHEMA && Array.isArray(old.messages) && old.messages.every(valid);
      if (old && !ok) s.put({ ...old, key: `aside:${key}:${Date.now()}` }); // keep it for recovery, never drop silently
      const merged = mergeForCache(ok ? old!.messages : [], ok ? !!old!.hasMore : false, messages, extra.hasMore);
      if (merged.disconnected) s.put({ ...old!, key: `aside:${key}:${Date.now()}` }); // rows kept under their own key
      const rec: ThreadRec<M> = { key, schema: SCHEMA, savedAt: Date.now(), ...extra, messages: merged.messages, hasMore: merged.hasMore };
      s.put(rec);
    };
  });
}

export async function readInbox<C>(meId: string): Promise<C[] | null> {
  const rec = await tx<InboxRec<C>>("inbox", "readonly", (s) => s.get(meId));
  return rec && rec.schema === SCHEMA && Array.isArray(rec.conversations) ? rec.conversations : null;
}

export function writeInbox<C>(meId: string, conversations: readonly C[]) {
  const rec: InboxRec<C> = { key: meId, schema: SCHEMA, savedAt: Date.now(), conversations: [...conversations] };
  return tx("inbox", "readwrite", (s) => s.put(rec));
}

/** Sign-out: forget this device's cached chats (every database this app created, set-aside ones included). */
export async function wipeChatCache() {
  if (!hasIdb()) return;
  const db = await dbp?.catch(() => null);
  db?.close();
  dbp = null;
  const names = new Set([dbName(), BASE]);
  try {
    const listed = await (indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }).databases?.();
    for (const d of listed ?? []) if (d.name?.startsWith(BASE)) names.add(d.name);
  } catch {
    /* Safari < 14 */
  }
  for (const n of names) indexedDB.deleteDatabase(n);
  try {
    localStorage.removeItem(NAME_KEY);
    localStorage.removeItem(`${NAME_KEY}-aside`);
  } catch {
    /* ignore */
  }
}
