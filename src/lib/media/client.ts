"use client";
// Client side of the media pipeline: resumable chunked uploads (XHR for byte-level progress, adaptive chunk size,
// automatic resume after network drops / app backgrounding), batched short-lived signed URLs, and media actions.
import { authFetch, getAccessToken } from "@/lib/auth";
import type { DirectMessage } from "@/lib/types";
import type { MediaAttachment, MediaKind, MediaUpdateEvent, MediaVariant } from "./types";
import { beginCritical } from "./critical";

export class UploadCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "UploadCancelled";
  }
}
export class MediaHttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function postJson<T>(url: string, body: unknown, method = "POST"): Promise<T> {
  const res = await authFetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!res.ok || j.ok === false) throw new MediaHttpError(j.error || `Request failed (${res.status})`, res.status);
  return j;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function putChunk(url: string, body: Blob, token: string, onProgress: (sent: number) => void, signal: AbortSignal) {
  return new Promise<{ status: number; body: { received?: number; error?: string } }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.timeout = 60_000;
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let j = {};
      try {
        j = JSON.parse(xhr.responseText || "{}");
      } catch {}
      resolve({ status: xhr.status, body: j });
    };
    xhr.onerror = () => reject(new Error("network"));
    xhr.ontimeout = () => reject(new Error("timeout"));
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.onabort = () => reject(new UploadCancelled());
    xhr.send(body);
  });
}

export interface UploadOptions {
  kind: MediaKind;
  name?: string;
  onProgress?: (fraction: number, sentBytes: number) => void;
  signal?: AbortSignal;
}

/**
 * Upload a file in chunks. The chunk size adapts to the connection (aims for ~2.5 s per chunk, 256 KB – 8 MB) so slow
 * networks never hit request timeouts and fast ones aren't held back. Network errors resume from the server's offset.
 */
export async function uploadMedia(file: Blob, opts: UploadOptions): Promise<MediaAttachment> {
  const signal = opts.signal ?? new AbortController().signal;
  const name = opts.name ?? (file as File).name ?? "file";
  const start = await postJson<{ uploadId: string; chunkSize: number; maxChunk: number }>("/api/media/uploads", { kind: opts.kind, name, size: file.size, mime: file.type });
  const id = start.uploadId;
  const onAbort = () => void authFetch(`/api/media/uploads/${id}`, { method: "DELETE" }).catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    let offset = 0;
    let chunk = Math.min(start.chunkSize || 512 * 1024, 1024 * 1024);
    let failures = 0;
    while (offset < file.size) {
      if (signal.aborted) throw new UploadCancelled();
      const end = Math.min(file.size, offset + chunk);
      const from = offset;
      const t0 = performance.now();
      try {
        const token = await getAccessToken();
        const r = await putChunk(`/api/media/uploads/${id}?offset=${offset}`, file.slice(offset, end), token, (sent) => opts.onProgress?.((offset + sent) / file.size, offset + sent), signal);
        if (r.status === 200 && typeof r.body.received === "number") {
          offset = r.body.received;
          failures = 0;
          const secs = (performance.now() - t0) / 1000;
          const rate = (end - from) / Math.max(0.05, secs);
          chunk = Math.round(Math.min(start.maxChunk || 8 * 1024 * 1024, Math.max(256 * 1024, rate * 2.5)));
        } else if (r.status === 409 && typeof r.body.received === "number") {
          offset = r.body.received; // server has a different offset (lost ack): continue from there
        } else if (r.status === 401) {
          await sleep(300);
        } else if (r.status >= 400 && r.status < 500) {
          throw new MediaHttpError(r.body.error || "Upload failed", r.status);
        } else throw new Error(`http ${r.status}`);
      } catch (e) {
        if (e instanceof UploadCancelled || e instanceof MediaHttpError) throw e;
        failures++;
        chunk = Math.max(256 * 1024, Math.round(chunk / 2));
        // offline: wait for the network to come back, then ask the server where we are
        if (typeof navigator !== "undefined" && navigator.onLine === false) await new Promise<void>((r) => window.addEventListener("online", () => r(), { once: true }));
        else await sleep(Math.min(15_000, 500 * 2 ** failures));
        if (failures > 12) throw new MediaHttpError("Upload failed. Check your connection and try again.", 0);
        const st = await authFetch(`/api/media/uploads/${id}`).then((r) => r.json()).catch(() => null);
        if (st?.ok && typeof st.received === "number") offset = st.received;
        else if (st && st.ok === false) throw new MediaHttpError(st.error || "Upload expired. Try again.", 404);
      }
    }
    opts.onProgress?.(1, file.size);
    for (let attempt = 0; ; attempt++) {
      try {
        const done = await postJson<{ media: MediaAttachment }>(`/api/media/uploads/${id}/complete`, {});
        return done.media;
      } catch (e) {
        if (e instanceof MediaHttpError && e.status >= 400 && e.status < 500) throw e;
        if (attempt >= 3) throw e;
        await sleep(1000 * (attempt + 1));
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export interface SendMediaInput {
  to: string;
  /** one attachment … */
  mediaId?: string;
  /** … or an album (2–10 photos/videos, in order) */
  mediaIds?: string[];
  clientId: string;
  caption?: string;
  ttlSeconds?: number;
  viewOnce?: boolean;
  /** Existing message in this same conversation to quote on the sent attachment. */
  replyToId?: string;
}
export async function sendMedia(input: SendMediaInput) {
  return (await postJson<{ message: DirectMessage }>("/api/media/send", input)).message;
}

// ---------- signed URLs: batched + cached ----------

type Urls = Partial<Record<MediaVariant, string>> & { gone?: boolean };
const cache = new Map<string, { urls: Urls; until: number }>();
const cacheListeners = new Map<string, Set<() => void>>();
const pending = new Map<string, { v: MediaVariant[]; waiters: ((u: Urls) => void)[] }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const URL_CACHE_MS = 4 * 60_000;

function notifyCachedUrls(id: string) {
  for (const listener of cacheListeners.get(id) ?? []) listener();
}

export function variantsFor(m: MediaAttachment): MediaVariant[] {
  if (m.kind === "photo") return m.srcset ? ["thumb", "thumbS", "thumbAvif", "thumbSAvif", "full"] : ["thumb", "full"];
  if (m.kind === "video") return m.hls?.length ? ["poster", "full", "hls", "hlsLow"] : ["poster", "full"];
  if (m.kind === "voice") return ["full"];
  return m.thumb ? ["thumb", "full"] : ["full"];
}

async function flush() {
  flushTimer = null;
  const batch = [...pending.entries()].slice(0, 100);
  for (const [id] of batch) pending.delete(id);
  if (pending.size) flushTimer = setTimeout(flush, 0);
  // signing gates every thumbnail: it counts as critical (deferred downloads wait for it)
  const done = beginCritical();
  try {
    const r = await postJson<{ urls: Record<string, Urls> }>("/api/media/sign", { items: batch.map(([id, p]) => ({ id, v: p.v })) });
    preconnectTo(Object.values(r.urls)[0]);
    for (const [id, p] of batch) {
      const urls = r.urls[id] ?? { gone: true };
      cache.set(id, { urls, until: Date.now() + URL_CACHE_MS });
      notifyCachedUrls(id);
      p.waiters.forEach((w) => w(urls));
    }
  } catch {
    for (const [, p] of batch) p.waiters.forEach((w) => w({}));
  } finally {
    done();
  }
}

/** Media served from another origin (the self-hosted media cache, MEDIA_CDN_BASE): open its connections early, both
 *  the credentialed pool (<img>) and the anonymous one (hls.js / fetch), so the first thumbnail skips DNS+TCP+TLS. */
const preconnected = new Set<string>();
function preconnectTo(urls: Urls | undefined) {
  if (typeof document === "undefined" || !urls) return;
  const u = Object.values(urls).find((v): v is string => typeof v === "string" && /^https?:\/\//.test(v));
  if (!u) return;
  let origin: string;
  try {
    origin = new URL(u).origin;
  } catch {
    return;
  }
  if (origin === location.origin || preconnected.has(origin)) return;
  preconnected.add(origin);
  for (const cors of [false, true]) {
    const l = document.createElement("link");
    l.rel = "preconnect";
    l.href = origin;
    if (cors) l.crossOrigin = "anonymous";
    document.head.appendChild(l);
  }
}

/** Signed URLs for one attachment (cached ~4 min; requests from the same frame are batched into one call). */
export function getUrls(m: MediaAttachment, fresh = false): Promise<Urls> {
  const c = cache.get(m.id);
  if (c && !fresh && c.until > Date.now() && !(m.status === "ready" && c.urls.full?.includes("/original")) && !(m.hls?.length && !c.urls.hls)) return Promise.resolve(c.urls);
  return new Promise((resolve) => {
    const p = pending.get(m.id) ?? { v: variantsFor(m), waiters: [] };
    p.waiters.push(resolve);
    pending.set(m.id, p);
    if (!flushTimer) flushTimer = setTimeout(flush, 16);
  });
}
export const cachedUrls = (id: string) => {
  const c = cache.get(id);
  return c && c.until > Date.now() ? c.urls : null;
};
/** Subscribe to a pre-existing signed-URL cache entry without initiating a signing request. */
export function onCachedUrls(id: string, listener: () => void) {
  const listeners = cacheListeners.get(id) ?? new Set<() => void>();
  listeners.add(listener);
  cacheListeners.set(id, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) cacheListeners.delete(id);
  };
}
export const dropUrls = (id: string) => {
  cache.delete(id);
  notifyCachedUrls(id);
};

// ---------- actions ----------
export const openViewOnce = (id: string) => postJson<{ urls: Urls }>(`/api/media/${id}/open`, {});
export const markViewed = (id: string) => postJson(`/api/media/${id}/viewed`, {}).catch(() => {});
export const markPlayed = (id: string) => postJson(`/api/media/${id}/played`, {}).catch(() => {});
export const deleteMediaNow = (id: string, opts: { all?: boolean } = {}) => postJson(`/api/media/${id}/delete`, opts.all ? { all: true } : {});
export const reconcileMedia = (messageIds: string[]) => postJson<{ items: MediaUpdateEvent[] }>("/api/media/reconcile", { messageIds });
