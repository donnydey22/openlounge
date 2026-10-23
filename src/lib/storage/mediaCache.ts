"use client";
// Device media cache (Settings → Storage & data): chat thumbnails / posters kept in Cache Storage so chats show their
// media offline too. Media bytes ONLY: message text lives in the chat history cache (historyCache.ts) and is never
// touched by the cap, the LRU or "Clear media". Everything here re-downloads on demand (the server keeps the files).
// Index (localStorage): mediaId → { conv, bytes, at }. Over the cap, least-recently-used entries go first.

const CACHE = "ol-media-v1";
const INDEX_KEY = "openlounge:media-cache-index";
const CAP_KEY = "openlounge:media-cache-cap";
export const MEDIA_CACHE_EVENT = "openlounge:media-cache";
export const CAP_CHOICES = [100, 250, 500, 1000, 2000, 5000].map((mb) => mb * 1024 * 1024);
export const DEFAULT_CAP = 500 * 1024 * 1024;

export type IndexEntry = { conv: string; bytes: number; at: number };
type Index = Record<string, IndexEntry>;

const ok = () => typeof caches !== "undefined" && typeof localStorage !== "undefined";
const keyUrl = (id: string) => `/__ol-media-cache/${encodeURIComponent(id)}`;

export function readIndex(): Index {
  try {
    const v = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Index) : {};
  } catch {
    return {};
  }
}
function writeIndex(ix: Index) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(ix));
  } catch {}
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(MEDIA_CACHE_EVENT));
}

export function cacheCap(): number {
  try {
    const n = Number(localStorage.getItem(CAP_KEY));
    return CAP_CHOICES.includes(n) ? n : DEFAULT_CAP;
  } catch {
    return DEFAULT_CAP;
  }
}
export async function setCacheCap(bytes: number) {
  try {
    localStorage.setItem(CAP_KEY, String(bytes));
  } catch {}
  await enforceCap();
}

/** Pure LRU plan: which ids to drop so the total fits `cap` (oldest `at` first). Exported for tests. */
export function lruEvictions(ix: Index, cap: number, keep?: string): string[] {
  let total = Object.values(ix).reduce((n, e) => n + e.bytes, 0);
  if (total <= cap) return [];
  const out: string[] = [];
  for (const [id, e] of Object.entries(ix).sort((a, b) => a[1].at - b[1].at)) {
    if (total <= cap) break;
    if (id === keep) continue;
    out.push(id);
    total -= e.bytes;
  }
  return out;
}

async function enforceCap(keep?: string) {
  if (!ok()) return;
  const ix = readIndex();
  const drop = lruEvictions(ix, cacheCap(), keep);
  if (!drop.length) return;
  const c = await caches.open(CACHE);
  for (const id of drop) {
    await c.delete(keyUrl(id)).catch(() => false);
    delete ix[id];
  }
  writeIndex(ix);
}

const inflight = new Set<string>();
/** After a thumbnail displayed: keep a copy (same bytes, from the HTTP cache when possible). Fire-and-forget. */
export function rememberMedia(id: string, conv: string, url: string) {
  if (!ok() || inflight.has(id) || url.startsWith("blob:") || url.startsWith("data:")) return;
  const ix = readIndex();
  if (ix[id]) {
    ix[id].at = Date.now();
    return writeIndex(ix);
  }
  inflight.add(id);
  void (async () => {
    try {
      const r = await fetch(url, { cache: "force-cache", credentials: "same-origin", mode: "cors" });
      if (!r.ok) return;
      const blob = await r.blob();
      if (!blob.size || blob.size > 2 * 1024 * 1024) return; // thumbnails/posters only
      const c = await caches.open(CACHE);
      await c.put(keyUrl(id), new Response(blob, { headers: { "Content-Type": blob.type || "image/webp" } }));
      const next = readIndex();
      next[id] = { conv, bytes: blob.size, at: Date.now() };
      writeIndex(next);
      await enforceCap(id);
    } catch {
      /* offline / CORS / quota: just don't cache */
    } finally {
      inflight.delete(id);
    }
  })();
}

/** Offline / signing failed: a cached thumbnail as an object URL, or null. */
export async function cachedMediaUrl(id: string): Promise<string | null> {
  if (!ok() || !readIndex()[id]) return null;
  try {
    const r = await (await caches.open(CACHE)).match(keyUrl(id));
    if (!r) return null;
    const ix = readIndex();
    if (ix[id]) {
      ix[id].at = Date.now();
      writeIndex(ix);
    }
    return URL.createObjectURL(await r.blob());
  } catch {
    return null;
  }
}

export function usageByConv(ix: Index = readIndex()) {
  const by = new Map<string, { bytes: number; items: number }>();
  for (const e of Object.values(ix)) {
    const v = by.get(e.conv) ?? { bytes: 0, items: 0 };
    v.bytes += e.bytes;
    v.items++;
    by.set(e.conv, v);
  }
  return by;
}

/** "Clear media on this device" for one chat (or all): cached media bytes only; chats, text and server files stay. */
export async function clearMedia(conv?: string) {
  if (!ok()) return 0;
  const ix = readIndex();
  const c = await caches.open(CACHE);
  let freed = 0;
  for (const [id, e] of Object.entries(ix)) {
    if (conv && e.conv !== conv) continue;
    await c.delete(keyUrl(id)).catch(() => false);
    freed += e.bytes;
    delete ix[id];
  }
  writeIndex(ix);
  return freed;
}

/** Sign-out: forget cached media with the chats. */
export async function wipeMediaCache() {
  if (!ok()) return;
  await caches.delete(CACHE).catch(() => false);
  try {
    localStorage.removeItem(INDEX_KEY);
  } catch {}
}
