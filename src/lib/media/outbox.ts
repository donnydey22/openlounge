"use client";
// Outgoing attachments: an optimistic bubble appears instantly (local preview, real aspect ratio → no layout shift),
// the upload runs with a progress ring and a cancel button, then the server message replaces the bubble in place
// (same clientId). Failures keep the bubble with "Retry"; uploads resume after network drops on their own.
import { useSyncExternalStore } from "react";
import type { DirectMessage } from "@/lib/types";
import { MEDIA_LIMITS, albumLabel, formatBytes, mediaLabel, type MediaAttachment, type MediaKind } from "./types";
import { MediaHttpError, UploadCancelled, sendMedia, uploadMedia } from "./client";

export type OutboxPhase = "uploading" | "processing" | "sending" | "failed" | "done";
export interface OutboxEntry {
  clientId: string;
  peerId: string;
  file: Blob;
  name: string;
  kind: MediaKind;
  caption: string;
  ttlSeconds: number;
  viewOnce: boolean;
  progress: number;
  phase: OutboxPhase;
  error?: string;
  previewUrl?: string;
  uploaded?: MediaAttachment;
  controller: AbortController;
  /** albums: one entry per photo/video, uploaded in parallel, each with its own progress */
  items?: OutboxItem[];
}
export interface OutboxItem {
  file: Blob;
  name: string;
  kind: MediaKind;
  progress: number;
  previewUrl?: string;
  uploaded?: MediaAttachment;
}
/** parallel uploads per album (keeps each chunk fast on mobile links; the rest queue) */
const ALBUM_CONCURRENCY = 3;

const entries = new Map<string, OutboxEntry>();
const listeners = new Map<string, Set<() => void>>();
const emit = (cid: string) => listeners.get(cid)?.forEach((l) => l());
const patch = (cid: string, p: Partial<OutboxEntry>) => {
  const e = entries.get(cid);
  if (!e) return;
  entries.set(cid, { ...e, ...p });
  emit(cid);
};

export function useOutbox(clientId: string | undefined): OutboxEntry | null {
  return useSyncExternalStore(
    (cb) => {
      if (!clientId) return () => {};
      let set = listeners.get(clientId);
      if (!set) listeners.set(clientId, (set = new Set()));
      set.add(cb);
      return () => set!.delete(cb);
    },
    () => (clientId ? entries.get(clientId) ?? null : null),
    () => null,
  );
}
export const outboxEntry = (cid: string) => entries.get(cid) ?? null;

/** photo / video / voice / document from a picked file ("send as file" forces document) */
export function kindForFile(file: File, asFile = false): MediaKind {
  if (asFile) return "document";
  const t = file.type || "";
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (/^image\/(jpeg|png|gif|webp|heic|heif|avif)$/.test(t) || ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif"].includes(ext)) return "photo";
  if (t.startsWith("video/") || ["mp4", "mov", "m4v", "webm", "3gp", "mkv"].includes(ext)) return "video";
  return "document";
}

export function sizeError(file: Blob, kind: MediaKind) {
  const cap = MEDIA_LIMITS[kind];
  if (file.size > cap) return `${kind === "photo" ? "Photos" : kind === "video" ? "Videos" : "Files"} can be up to ${formatBytes(cap)}`;
  if (!file.size) return "That file is empty";
  return null;
}

/** dimensions (+ duration) read locally so the optimistic bubble has its final size */
export async function probeLocal(file: Blob, kind: MediaKind): Promise<{ w?: number; h?: number; durMs?: number; url?: string }> {
  const url = URL.createObjectURL(file);
  try {
    if (kind === "photo") {
      const img = new Image();
      img.decoding = "async";
      img.src = url;
      await Promise.race([img.decode(), new Promise((_, j) => setTimeout(j, 4000))]);
      return { w: img.naturalWidth, h: img.naturalHeight, url };
    }
    if (kind === "video") {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.playsInline = true;
      v.src = url;
      await Promise.race([new Promise((r, j) => ((v.onloadedmetadata = r), (v.onerror = j))), new Promise((_, j) => setTimeout(j, 4000))]);
      return { w: v.videoWidth || undefined, h: v.videoHeight || undefined, durMs: Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : undefined, url };
    }
  } catch {
    // HEIC on Chrome, HEVC on Firefox…: no local preview, the server still converts it
  }
  URL.revokeObjectURL(url);
  return { url: undefined };
}

export interface QueueOpts {
  peerId: string;
  me: { id: string; name: string; color: string };
  caption?: string;
  ttlSeconds?: number;
  viewOnce?: boolean;
  /** extra local info for voice notes (live waveform + duration while recording) */
  voice?: { durMs: number; wave: string };
  now: number;
  newClientId: () => string;
}

export interface QueueCallbacks {
  onDone: (clientId: string, message: DirectMessage) => void;
  onFail: (clientId: string, error: string) => void;
  onCancel: (clientId: string) => void;
}

/** Create the optimistic message for one file and start uploading it. */
export async function queueMedia(file: File | Blob, kind: MediaKind, o: QueueOpts, cb: QueueCallbacks): Promise<DirectMessage & { state: "sending" }> {
  const clientId = o.newClientId();
  const name = (file as File).name || (kind === "voice" ? "voice" : "file");
  const local = kind === "photo" || kind === "video" ? await probeLocal(file, kind) : {};
  const expiring = !!o.viewOnce || !!o.ttlSeconds;
  const caption = expiring ? "" : (o.caption ?? "").trim();
  const media: MediaAttachment = {
    id: `local-${clientId}`,
    kind,
    mime: file.type || "application/octet-stream",
    size: file.size,
    name,
    ...(local.w && local.h ? { w: local.w, h: local.h } : {}),
    ...(local.durMs ? { durMs: local.durMs } : o.voice ? { durMs: o.voice.durMs } : {}),
    ...(o.voice ? { wave: o.voice.wave } : {}),
    status: "processing",
    label: !caption,
    ...(o.ttlSeconds ? { ttl: o.ttlSeconds, expiresAt: null } : {}),
    ...(o.viewOnce ? { viewOnce: true } : {}),
  };
  const entry: OutboxEntry = {
    clientId,
    peerId: o.peerId,
    file,
    name,
    kind,
    caption,
    ttlSeconds: o.ttlSeconds ?? 0,
    viewOnce: !!o.viewOnce,
    progress: 0,
    phase: "uploading",
    previewUrl: local.url,
    controller: new AbortController(),
  };
  entries.set(clientId, entry);
  void run(clientId, cb);
  return {
    id: `local-${clientId}`,
    clientId,
    fromId: o.me.id,
    fromName: o.me.name,
    fromColor: o.me.color,
    toId: o.peerId,
    text: caption || mediaLabel(media),
    createdAt: o.now,
    media,
    state: "sending",
  };
}

/** Create ONE optimistic album message for 2–10 photos/videos and upload them in parallel. */
export async function queueAlbum(files: File[], o: QueueOpts, cb: QueueCallbacks): Promise<DirectMessage & { state: "sending" }> {
  const clientId = o.newClientId();
  const expiring = !!o.ttlSeconds;
  const caption = expiring ? "" : (o.caption ?? "").trim();
  const items: OutboxItem[] = [];
  const atts: MediaAttachment[] = [];
  const probes = await Promise.all(files.map((f) => probeLocal(f, kindForFile(f))));
  files.forEach((file, i) => {
    const kind = kindForFile(file);
    const local = probes[i];
    items.push({ file, name: file.name || `item-${i + 1}`, kind, progress: 0, previewUrl: local.url });
    atts.push({
      id: `local-${clientId}-${i}`,
      kind,
      mime: file.type || "application/octet-stream",
      size: file.size,
      name: file.name,
      ...(local.w && local.h ? { w: local.w, h: local.h } : {}),
      ...(local.durMs ? { durMs: local.durMs } : {}),
      status: "processing",
      label: !caption,
      ...(o.ttlSeconds ? { ttl: o.ttlSeconds, expiresAt: null } : {}),
    });
  });
  const total = files.reduce((n, f) => n + f.size, 0);
  entries.set(clientId, {
    clientId,
    peerId: o.peerId,
    file: files[0],
    name: items[0].name,
    kind: items[0].kind,
    caption,
    ttlSeconds: o.ttlSeconds ?? 0,
    viewOnce: false,
    progress: 0,
    phase: "uploading",
    previewUrl: items[0].previewUrl,
    controller: new AbortController(),
    items,
  });
  void run(clientId, cb);
  return {
    id: `local-${clientId}`,
    clientId,
    fromId: o.me.id,
    fromName: o.me.name,
    fromColor: o.me.color,
    toId: o.peerId,
    text: caption || albumLabel(atts),
    createdAt: o.now,
    media: { ...atts[0], size: total },
    attachments: atts,
    state: "sending",
  };
}

function patchItem(cid: string, i: number, p: Partial<OutboxItem>) {
  const e = entries.get(cid);
  if (!e?.items) return;
  const items = e.items.map((it, j) => (j === i ? { ...it, ...p } : it));
  const total = items.reduce((n, it) => n + it.file.size, 0) || 1;
  const progress = items.reduce((n, it) => n + it.progress * it.file.size, 0) / total;
  entries.set(cid, { ...e, items, progress });
  emit(cid);
}

async function uploadAlbum(clientId: string) {
  const e = entries.get(clientId)!;
  const todo = e.items!.map((it, i) => ({ it, i })).filter((x) => !x.it.uploaded);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const { it, i } = todo[next++];
      const up = await uploadMedia(it.file, {
        kind: it.kind,
        name: it.name,
        signal: entries.get(clientId)!.controller.signal,
        onProgress: (p) => {
          const cur = entries.get(clientId)?.items?.[i];
          if (cur && Math.abs(p - cur.progress) >= 0.01) patchItem(clientId, i, { progress: Math.min(p, 0.999) });
        },
      });
      patchItem(clientId, i, { uploaded: up, progress: 1 });
    }
  };
  await Promise.all(Array.from({ length: Math.min(ALBUM_CONCURRENCY, todo.length) }, worker));
  return entries.get(clientId)!.items!.map((it) => it.uploaded!.id);
}

async function run(clientId: string, cb: QueueCallbacks) {
  const e = entries.get(clientId);
  if (!e) return;
  try {
    if (e.items) {
      patch(clientId, { phase: "uploading", error: undefined });
      const mediaIds = await uploadAlbum(clientId);
      patch(clientId, { phase: "sending" });
      const message = await sendWithRetry({ to: e.peerId, mediaIds, clientId, caption: e.caption, ttlSeconds: e.ttlSeconds || undefined });
      patch(clientId, { phase: "done" });
      cb.onDone(clientId, message);
      setTimeout(() => {
        entries.get(clientId)?.items?.forEach((it) => it.previewUrl && URL.revokeObjectURL(it.previewUrl));
        entries.delete(clientId);
        emit(clientId);
      }, 30_000);
      return;
    }
    let uploaded = e.uploaded;
    if (!uploaded) {
      patch(clientId, { phase: "uploading", error: undefined });
      uploaded = await uploadMedia(e.file, {
        kind: e.kind,
        name: e.name,
        signal: e.controller.signal,
        onProgress: (p) => {
          const cur = entries.get(clientId);
          // repaint at most every 1% (ring) — cheap even for many uploads
          if (cur && Math.abs(p - cur.progress) >= 0.01) patch(clientId, { progress: p, phase: p >= 1 ? "processing" : "uploading" });
        },
      });
      patch(clientId, { uploaded, progress: 1, phase: "sending" });
    }
    const message = await sendWithRetry({ to: e.peerId, mediaId: uploaded.id, clientId, caption: e.caption, ttlSeconds: e.ttlSeconds || undefined, viewOnce: e.viewOnce || undefined });
    patch(clientId, { phase: "done" });
    cb.onDone(clientId, message);
    // keep the local preview until the bubble swapped to the server copy and its thumbnail loaded
    setTimeout(() => {
      const cur = entries.get(clientId);
      if (cur?.previewUrl) URL.revokeObjectURL(cur.previewUrl);
      entries.delete(clientId);
      emit(clientId);
    }, 30_000);
  } catch (err) {
    if (err instanceof UploadCancelled || entries.get(clientId)?.controller.signal.aborted) {
      const cur = entries.get(clientId);
      entries.get(clientId)?.controller.abort(); // album: stop the sibling uploads too
      if (cur?.previewUrl) URL.revokeObjectURL(cur.previewUrl);
      cur?.items?.forEach((it) => it.previewUrl && it.previewUrl !== cur.previewUrl && URL.revokeObjectURL(it.previewUrl));
      entries.delete(clientId);
      emit(clientId);
      cb.onCancel(clientId);
      return;
    }
    const msg = err instanceof MediaHttpError ? err.message : "Couldn't send. Tap to retry.";
    // album: stop the other uploads (finished ones are kept and not re-uploaded on retry)
    if (e.items) {
      entries.get(clientId)?.controller.abort();
      patch(clientId, { controller: new AbortController() });
    }
    patch(clientId, { phase: "failed", error: msg });
    cb.onFail(clientId, msg);
  }
}

async function sendWithRetry(input: Parameters<typeof sendMedia>[0]) {
  for (let i = 0; ; i++) {
    try {
      return await sendMedia(input);
    } catch (e) {
      if (e instanceof MediaHttpError && e.status >= 400 && e.status < 500) throw e;
      if (i >= 4) throw e;
      await new Promise((r) => setTimeout(r, 800 * 2 ** i));
    }
  }
}

export function retryMedia(clientId: string, cb: QueueCallbacks) {
  const e = entries.get(clientId);
  if (!e) return false;
  if (e.controller.signal.aborted) e.controller = new AbortController();
  void run(clientId, cb);
  return true;
}

export function cancelMedia(clientId: string) {
  entries.get(clientId)?.controller.abort();
}
