// Local-first message store (WhatsApp / Telegram style): every message row a thread has loaded is kept on the device,
// one IndexedDB record per message, so a chat opens from the device instantly and scrolling back reads the device
// first and asks the server only on a cache miss.
// - Append-only: a page writes only its own rows (one put each); the thread is never read back and rewritten.
// - Never trims or deletes rows. A message deleted for me / for everyone gets a `gone` mark (row kept, never shown).
// - Gap-safe: each row remembers the id of its older neighbour on the server (`prev`; "" = first message of the
//   chat). A read walks that chain and stops at the first link it can't prove, then the server fills in the rest,
//   so a cache that was offline for weeks never shows a silent hole.
// - Separate database (ol-chat-msgs) so older builds' ol-chat database keeps working untouched; wiped on sign-out.
import type { CachedMsg } from "./historyReconcile";

export const MSG_DB = "ol-chat-msgs";
const VERSION = 1;
const SEP = "\u0001";
const pad = (n: number) => String(Math.max(0, Math.floor(n))).padStart(14, "0");
const keyFor = (thread: string, m: { createdAt: number; id: string }) => `${thread}${SEP}${pad(m.createdAt)}${SEP}${m.id}`;

type Row<M> = { k: string; t: string; id: string; m: M; prev?: string | null; at: number; gone?: 1 };
export type CachePage<M> = { messages: M[]; reachedStart: boolean; full: boolean };

let dbp: Promise<IDBDatabase | null> | null = null;
const hasIdb = () => typeof indexedDB !== "undefined" && indexedDB !== null;

function open(): Promise<IDBDatabase | null> {
  if (!hasIdb()) return Promise.resolve(null);
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(MSG_DB, VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("msgs")) db.createObjectStore("msgs", { keyPath: "k" }).createIndex("id", ["t", "id"], { unique: false });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "t" });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbp = null;
      };
      resolve(db);
    };
    req.onerror = () => resolve(null); // no cache this session: the server path still works
    req.onblocked = () => resolve(null);
  });
  return dbp;
}

function run<T>(stores: string[], mode: IDBTransactionMode, body: (t: IDBTransaction, done: (v: T) => void) => void, fallback: T): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve) => {
        if (!db) return resolve(fallback);
        let out = fallback;
        try {
          const t = db.transaction(stores, mode);
          body(t, (v) => (out = v));
          t.oncomplete = () => resolve(out);
          t.onerror = t.onabort = () => resolve(fallback);
        } catch {
          resolve(fallback);
        }
      }),
  );
}

export const threadKey = (meId: string, peerId: string) => `${meId}:${peerId}`;

/**
 * Walk the chain from the newest row below `upper` (exclusive key) towards older ones, up to `limit` visible rows.
 * `anchorPrev`: the older-neighbour id the first row must have (undefined = newest page, any row may start).
 */
function walk<M extends CachedMsg>(t: IDBTransaction, thread: string, upper: string, anchorPrev: string | null | undefined, limit: number, done: (p: CachePage<M>) => void) {
  const out: M[] = [];
  const range = IDBKeyRange.bound(`${thread}${SEP}`, upper, false, true);
  let expect: string | null | undefined = anchorPrev; // id the next (older) row must have
  let reachedStart = anchorPrev === "";
  if (reachedStart) return done({ messages: [], reachedStart: true, full: true });
  const req = t.objectStore("msgs").openCursor(range, "prev");
  req.onsuccess = () => {
    const c = req.result;
    const finish = () => done({ messages: out.reverse(), reachedStart, full: reachedStart || out.length >= limit });
    if (!c) return finish();
    const row = c.value as Row<M>;
    if (expect !== undefined && row.id !== expect) return finish(); // unproven link: let the server fill the gap
    if (!row.gone) out.push(row.m);
    expect = row.prev;
    if (expect === "") reachedStart = true;
    if (reachedStart || expect == null || out.length >= limit) {
      // expect == null: we don't know what's older than this row → stop here (server continues from it)
      if (expect == null && !reachedStart) return done({ messages: out.reverse(), reachedStart: false, full: out.length >= limit });
      return finish();
    }
    c.continue();
  };
}

/** Newest rows of a thread (oldest-first), as far as the chain is proven, up to `limit`. */
export function readNewest<M extends CachedMsg>(thread: string, limit: number): Promise<CachePage<M>> {
  return run<CachePage<M>>(["msgs"], "readonly", (t, done) => walk<M>(t, thread, `${thread}${SEP}~`, undefined, limit, done), { messages: [], reachedStart: false, full: false });
}

/** Rows older than `before` (an already-shown message), only while the chain from it is proven. */
export function readOlder<M extends CachedMsg>(thread: string, before: { id: string; createdAt: number }, limit: number): Promise<CachePage<M>> {
  return run<CachePage<M>>(
    ["msgs"],
    "readonly",
    (t, done) => {
      const g = t.objectStore("msgs").get(keyFor(thread, before));
      g.onsuccess = () => {
        const anchor = g.result as Row<M> | undefined;
        if (!anchor || anchor.prev == null) return done({ messages: [], reachedStart: false, full: false });
        walk<M>(t, thread, keyFor(thread, before), anchor.prev, limit, done);
      };
    },
    { messages: [], reachedStart: false, full: false },
  );
}

/**
 * Store one server page (oldest-first, exactly as the server returned it). Only this page's rows are written.
 * `newerId`: the message the page was requested before (beforeId) — its older neighbour is the page's newest row.
 * `reachedStart`: the page includes message #1 (hasMore false).
 */
export function putPage<M extends CachedMsg>(thread: string, page: readonly M[], o: { newerId?: string | null; newerAt?: number; reachedStart: boolean }) {
  const rows = page.filter((m) => !m.state && typeof m.id === "string" && !m.id.startsWith("tmp"));
  if (!rows.length && !(o.newerId && o.reachedStart)) return Promise.resolve();
  const at = Date.now();
  return run<void>(["msgs"], "readwrite", (t) => {
    const s = t.objectStore("msgs");
    rows.forEach((m, i) => {
      const k = keyFor(thread, m);
      if (i > 0) return void s.put({ k, t: thread, id: m.id, m, prev: rows[i - 1].id, at } satisfies Row<M>);
      if (o.reachedStart) return void s.put({ k, t: thread, id: m.id, m, prev: "", at } satisfies Row<M>);
      // oldest row of a page with more before it: keep any link we already proved
      const g = s.get(k);
      g.onsuccess = () => {
        const old = g.result as Row<M> | undefined;
        s.put({ k, t: thread, id: m.id, m, prev: old?.prev ?? null, at, ...(old?.gone && !(m as { deleted?: boolean }).deleted ? { gone: 1 as const } : {}) } satisfies Row<M>);
      };
    });
    if (o.newerId && typeof o.newerAt === "number") {
      const k = keyFor(thread, { id: o.newerId, createdAt: o.newerAt });
      const g = s.get(k);
      g.onsuccess = () => {
        const old = g.result as Row<M> | undefined;
        if (old) s.put({ ...old, prev: rows.length ? rows[rows.length - 1].id : o.reachedStart ? "" : old.prev });
      };
    }
  }, undefined);
}

/** Live rows / edits / reactions / receipts: write just these rows, keeping each row's proven link. */
export function putMessages<M extends CachedMsg>(thread: string, list: readonly M[], prevOf?: (m: M) => string | undefined) {
  const rows = list.filter((m) => !m.state && typeof m.id === "string" && !m.id.startsWith("tmp"));
  if (!rows.length) return Promise.resolve();
  const at = Date.now();
  return run<void>(["msgs"], "readwrite", (t) => {
    const s = t.objectStore("msgs");
    for (const m of rows) {
      const k = keyFor(thread, m);
      const g = s.get(k);
      g.onsuccess = () => {
        const old = g.result as Row<M> | undefined;
        // prevOf: the thread knows this row's older neighbour (live message on a synced, connected thread)
        s.put({ k, t: thread, id: m.id, m, prev: old?.prev ?? prevOf?.(m) ?? null, at, ...(old?.gone && !(m as { deleted?: boolean }).deleted ? { gone: 1 as const } : {}) } satisfies Row<M>);
      };
    }
  }, undefined);
}

/** Deleted (for me or for everyone): the row is kept (chain intact) and never shown again. */
export function markGone(thread: string, ids: readonly string[]) {
  if (!ids.length) return Promise.resolve();
  return run<void>(["msgs"], "readwrite", (t) => {
    const idx = t.objectStore("msgs").index("id");
    for (const id of ids) {
      const g = idx.openCursor(IDBKeyRange.only([thread, id]));
      g.onsuccess = () => {
        const c = g.result;
        if (!c) return;
        c.update({ ...(c.value as Row<CachedMsg>), gone: 1 });
        c.continue();
      };
    }
  }, undefined);
}

/** Header info (peer / group) so the chat renders fully before the server answers. */
export function readMeta<P>(thread: string): Promise<P | null> {
  return run<P | null>(["meta"], "readonly", (t, done) => {
    const g = t.objectStore("meta").get(thread);
    g.onsuccess = () => done((g.result as { v?: P } | undefined)?.v ?? null);
  }, null);
}
export function writeMeta<P>(thread: string, v: P) {
  return run<void>(["meta"], "readwrite", (t) => void t.objectStore("meta").put({ t: thread, v, at: Date.now() }), undefined);
}

/** Sign-out: forget every cached message on this device. */
export async function wipeMsgStore() {
  if (!hasIdb()) return;
  const db = await dbp?.catch(() => null);
  db?.close();
  dbp = null;
  try {
    indexedDB.deleteDatabase(MSG_DB);
  } catch {
    /* ignore */
  }
}
