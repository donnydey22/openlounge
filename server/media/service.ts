// Media service: resumable uploads → validation + processing → attachment on a DM → short-lived signed URLs,
// block-aware access, self-destruct timers / view once / "Delete now", and cleanup sweeps.
//
// Lifecycle of one attachment:
//   POST /api/media/uploads            → upload session (tmp file + JSON sidecar on the volume, survives restarts)
//   PUT  /api/media/uploads/:id?offset → chunks (adaptive size on the client; offset must match → resumable)
//   POST /api/media/uploads/:id/complete → sniff (magic bytes) + sharp / ffmpeg → media row (status ready|processing)
//   POST /api/media/send               → DM with `media` (label or caption as text), pushed as dm:message
//   POST /api/media/sign               → signed URLs (10 min, viewer-bound) for what's on screen
//   GET  /api/media/f/:id/:variant     → file (Range support; access re-checked on every request)
// Expiry: the sweeper deletes the file + media row at expiresAt (recipient online or not), leaves a tombstone so the
// bubble becomes "Photo expired", and pushes "media:update" to both sides. Reconnecting clients reconcile.
import { applyValidators, notModifiedHeaders } from "./conditional";
import { conversationId as convKey, isGroupId } from "../conversation";
import { ALLOWANCE_DEFAULTS, allowance } from "./allowance";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { store } from "../store";
import { log, metrics } from "../log";
import {
  MAX_TTL_SECONDS,
  MEDIA_KINDS,
  MEDIA_LIMITS,
  MIN_TTL_SECONDS,
  VIEW_ONCE_GRACE_MS,
  mediaLabel,
  albumLabel,
  ALBUM_MAX,
  type MediaAttachment,
  type MediaGoneReason,
  type MediaKind,
  type MediaUpdateEvent,
  type MediaVariant,
} from "../../src/lib/media/types";
import {
  CHUNK_DEFAULT_BYTES,
  CHUNK_MAX_BYTES,
  DISK_RESERVE_BYTES,
  MAX_OPEN_UPLOADS,
  MEDIA_DIR,
  SWEEP_MS,
  TMP_DIR,
  UNSENT_TTL_MS,
  UPLOAD_DIR,
  UPLOAD_STALE_MS,
  UPLOADS_PER_10MIN,
  URL_TTL_S,
  URL_WINDOW_S,
  HLS_ENABLED,
  HLS_MAX_MS,
  HLS_URL_EXTRA_S,
} from "./config";
import { configureOrigin, purgeCache, signedUrl, startInternalOrigin, setFallbackSecret, type OriginFile } from "./origin";
import { encodeRungs, hlsQueue, ladderFor, probe as probeVideo, rungInfo, writeMasters, type RungInfo } from "./hls";
import { INLINE_SAFE, safeName, sniff } from "./sniff";
import { MediaError, ffmpegAvailable, gifFrames, keepOriginalVideo, processImage, processVideo, processVoice, transcodeVideo, placeholderFrom } from "./process";
import { keepOriginalPhoto } from "./original";
import { MemoryMediaRepo, PgMediaRepo, type MediaRepo, type MediaRow, type Tombstone } from "./repo";

type Hub = { to(channel: string): { emit(ev: string, data: unknown): void } };

interface UploadSession {
  id: string;
  ownerId: string;
  kind: MediaKind;
  name: string;
  size: number;
  declaredMime: string;
  createdAt: number;
  updatedAt: number;
  /** sniffed on the first chunk */
  sniffed?: string;
}

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const VARIANTS: MediaVariant[] = ["full", "thumb", "poster", "original", "hls", "hlsLow", "thumbS", "thumbAvif", "thumbSAvif", "source"];
/** Self-destructing (timer or view once): served no-store from the origin only, never edge-cached, never HLS. */
const isTimed = (r: { expiresAt?: number | null; viewOnce?: boolean; ttlSeconds?: number | null }) => !!(r.expiresAt || r.viewOnce || r.ttlSeconds);
/** keep a lossless, metadata-stripped original for "Download original" (MEDIA_KEEP_ORIGINALS=0 turns it off) */
const KEEP_ORIGINALS = process.env.MEDIA_KEEP_ORIGINALS !== "0";
const HLS_PATH_RE = /^hls\/r(\d{2,4})\/(index\.m3u8|init\.mp4|seg_\d{5}\.m4s)$/;
const HLS_MIME = "application/vnd.apple.mpegurl";
const IMMUTABLE = "public, max-age=31536000, immutable";

export class MediaService {
  repo: MediaRepo | null = null;
  private rows = new Map<string, MediaRow>();
  private byMessage = new Map<string, string[]>(); // messageId -> mediaIds (albums: several)
  private tombs = new Map<string, Tombstone>(); // messageId -> tombstone
  private sessions = new Map<string, UploadSession>();
  private busy = new Set<string>(); // uploads with a chunk / complete in flight
  private uploadRate = new Map<string, number[]>();
  private timers = new Map<string, NodeJS.Timeout>(); // mediaId -> precise expiry timer
  private hub: Hub | null = null;
  private secret: Buffer = randomBytes(32);
  private initP: Promise<void> | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private resolver: ((conversationId: string) => string[] | null) | null = null;
  ffmpeg = false;

  /** Groups: let the conversation owner resolve members for non-DM conversation ids. */
  setConversationResolver(fn: (conversationId: string) => string[] | null) {
    this.resolver = fn;
  }

  attachHub(hub: Hub) {
    this.hub = hub;
    // origin-only port for the self-hosted media cache (Railway private networking)
    startInternalOrigin();
  }

  ready() {
    return (this.initP ??= this.init());
  }

  private async init() {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    this.secret = this.loadSecret();
    setFallbackSecret(this.secret);
    configureOrigin(
      (uid, id, rev, rest) => this.originFile(uid, id, rev, rest),
      () => ({ ffmpeg: this.ffmpeg, queue: hlsQueue.depth, ...this.disk() }),
    );
    this.ffmpeg = await ffmpegAvailable();
    const url = process.env.DATABASE_URL;
    this.repo = url ? new PgMediaRepo(url) : new MemoryMediaRepo();
    // store.init() ran the migrations (026_media.sql) before we get here
    const [rows, tombs] = await Promise.all([this.repo.all(), this.repo.tombstones()]);
    for (const t of tombs) {
      this.tombs.set(t.messageId, t);
      const m = t.conversationId ? store.findDm(t.conversationId, t.messageId) : null;
      if (m) m.media = this.goneAttachment(t, m.media);
    }
    for (const r of rows) {
      this.rows.set(r.id, r);
      this.link(r);
    }
    // ladders interrupted by a deploy/restart: redo them in the background (new rev → fresh URLs)
    for (const r of rows) if (this.wantsHls(r) && !r.files.hls?.final && r.status !== "failed") void this.buildHls(r, { restart: true }).catch(() => {});
    for (const [mid, ids] of this.byMessage) {
      const first = this.rows.get(ids[0]);
      const m = first?.conversationId ? store.findDm(first.conversationId, mid) : null;
      if (!m) continue;
      const list = this.itemsOfMessage(mid).map((r) => this.toAttachment(r));
      m.media = list[0];
      if (list.length > 1) m.attachments = list;
    }
    // resume upload sessions (sidecars) so a deploy mid-upload just continues
    for (const f of fs.readdirSync(TMP_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(TMP_DIR, f), "utf8")) as UploadSession;
        if (ID_RE.test(s.id)) this.sessions.set(s.id, s);
      } catch {
        fs.rmSync(path.join(TMP_DIR, f), { force: true });
      }
    }
    for (const r of this.rows.values()) {
      if (r.expiresAt) this.schedule(r);
      if (r.status === "processing" && r.messageId !== undefined) void this.finishVideo(r).catch(() => {});
    }
    this.sweepTimer = setInterval(() => void this.sweep().catch((err) => log.warn("media sweep failed", { err })), SWEEP_MS);
    this.sweepTimer.unref();
    void this.sweep().catch(() => {});
    metrics.gauge("media_rows", () => this.rows.size);
    log.info("media ready", { dir: UPLOAD_DIR, storage: this.repo.kind, rows: this.rows.size, ffmpeg: this.ffmpeg, ...this.disk() });
  }

  async close() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await this.repo?.close();
    this.initP = null;
  }

  private loadSecret() {
    if (process.env.MEDIA_URL_SECRET) return Buffer.from(process.env.MEDIA_URL_SECRET);
    const f = path.join(UPLOAD_DIR, ".url-secret");
    try {
      const b = fs.readFileSync(f);
      if (b.length >= 32) return b;
    } catch {}
    const b = randomBytes(32);
    fs.writeFileSync(f, b, { mode: 0o600 });
    return b;
  }

  disk() {
    try {
      const s = fs.statfsSync(UPLOAD_DIR);
      return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
    } catch {
      return { freeBytes: Number.MAX_SAFE_INTEGER, totalBytes: 0 };
    }
  }

  // ---------- membership & access ----------

  /** members of a conversation (DMs: "<a>|<b>"; groups via the resolver) */
  /**
   * Settings → Storage & data: media in the chats this user can see, per chat (bytes on the server, how many items,
   * how much of it they sent), plus their allowance under the report-only formula in allowance.ts. Read only.
   */
  usage(uid: string) {
    const chats = new Map<string, { conv: string; bytes: number; items: number; mine: number }>();
    const senders = new Set<string>();
    const since = Date.now() - 30 * 86_400_000;
    let mine = 0;
    for (const r of this.rows.values()) {
      if (!r.messageId) continue;
      if ((r.createdAt ?? 0) >= since) senders.add(r.ownerId);
      if (!this.canView(uid, r)) continue;
      const bytes = Object.values(r.files).reduce((n, f) => n + (f?.size ?? 0), 0);
      const cid = r.conversationId ?? "";
      const conv = isGroupId(cid) ? cid : cid.split("|").find((x) => x !== uid) ?? uid;
      const c = chats.get(conv) ?? { conv, bytes: 0, items: 0, mine: 0 };
      c.bytes += bytes;
      c.items++;
      if (r.ownerId === uid) {
        c.mine += bytes;
        mine += bytes;
      }
      chats.set(conv, c);
    }
    const a = allowance({ volumeBytes: ALLOWANCE_DEFAULTS.volumeBytes, activeSenders: senders.size });
    return { chats: [...chats.values()].sort((x, y) => y.bytes - x.bytes), sentBytes: mine, ...a };
  }

  members(conversationId: string | null): string[] {
    if (!conversationId) return [];
    const viaResolver = this.resolver?.(conversationId);
    if (viaResolver) return viaResolver;
    const parts = conversationId.split("|");
    return parts.length === 2 ? parts : [];
  }

  /** Can `viewerId` see this media right now? (owner / member, no block either way, message still exists, not gone) */
  canView(viewerId: string, r: MediaRow, now = Date.now()) {
    if (r.expiresAt && r.expiresAt <= now) return false;
    if (!store.users.has(viewerId)) return false;
    if (!r.messageId) return r.ownerId === viewerId; // uploaded, not sent yet
    const members = this.members(r.conversationId);
    if (!members.includes(viewerId)) return false;
    if (viewerId !== r.ownerId && store.isBlockedEither(viewerId, r.ownerId)) return false;
    if (r.conversationId && (r.conversationId.includes("|") || isGroupId(r.conversationId)) && !store.findDm(r.conversationId, r.messageId)) return false;
    return true;
  }

  // ---------- attachment shapes ----------

  toAttachment(r: MediaRow): MediaAttachment {
    return {
      id: r.id,
      kind: r.kind,
      mime: r.mime,
      size: r.size,
      ...(r.name ? { name: r.name } : {}),
      ...(r.width ? { w: r.width } : {}),
      ...(r.height ? { h: r.height } : {}),
      ...(r.durationMs ? { durMs: r.durationMs } : {}),
      ...(r.waveform ? { wave: r.waveform } : {}),
      ...(r.placeholder ? { ph: r.placeholder } : {}),
      ...(r.gif ? { gif: true } : {}),
      status: r.status,
      ...(r.files.thumb ? { thumb: true } : {}),
      ...(r.files.poster ? { poster: true } : {}),
      // self-destructing media plays from the no-store origin MP4 only: its HLS ladder is never advertised (the origin
      // refuses timed HLS, and an advertised ladder made players retry 404s in a loop)
      ...(r.files.hls?.rungs?.length && !isTimed(r) ? { hls: r.files.hls.rungs } : {}),
      ...(r.files.thumbS ? { srcset: true } : {}),
      // "Download original" is never offered for self-destructing / view-once media
      ...(r.files.source && !(r.expiresAt || r.viewOnce || r.ttlSeconds) ? { orig: { size: r.files.source.size, mime: r.files.source.mime } } : {}),
      label: r.label,
      ...(r.ttlSeconds ? { ttl: r.ttlSeconds } : {}),
      ...(r.viewOnce ? { viewOnce: true } : {}),
      ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
      ...(r.openedAt ? { openedAt: r.openedAt } : {}),
      ...(r.playedAt ? { playedAt: r.playedAt } : {}),
    };
  }

  private goneAttachment(t: Tombstone, prev?: MediaAttachment): MediaAttachment {
    return {
      id: t.mediaId,
      kind: t.kind,
      mime: "",
      size: 0,
      status: "ready",
      label: true,
      ...(t.gif ? { gif: true } : {}),
      ...(t.viewOnce ? { viewOnce: true } : {}),
      ...(prev?.w && prev?.h ? { w: prev.w, h: prev.h } : {}),
      gone: { reason: t.reason, at: t.at },
    };
  }

  private broadcast(r: { conversationId: string | null }, ev: MediaUpdateEvent) {
    if (!this.hub) return;
    for (const uid of this.members(r.conversationId)) this.hub.to(`user:${uid}`).emit("media:update", ev);
  }

  private publish(r: MediaRow) {
    if (r.messageId) this.publishMessage(r.conversationId, r.messageId);
  }

  // ---------- message ↔ media rows (albums: several rows per message, ordered by position) ----------

  private link(r: MediaRow) {
    if (!r.messageId) return;
    const l = this.byMessage.get(r.messageId) ?? [];
    if (!l.includes(r.id)) l.push(r.id);
    this.byMessage.set(r.messageId, l);
  }
  private unlink(r: MediaRow) {
    if (!r.messageId) return;
    const l = (this.byMessage.get(r.messageId) ?? []).filter((id) => id !== r.id);
    if (l.length) this.byMessage.set(r.messageId, l);
    else this.byMessage.delete(r.messageId);
  }
  private itemsOfMessage(messageId: string): MediaRow[] {
    return (this.byMessage.get(messageId) ?? [])
      .map((id) => this.rows.get(id))
      .filter((r): r is MediaRow => !!r)
      .sort((a, b) => a.position - b.position);
  }

  /** Current attachment state of a message: { media (cover / single / gone), attachments (albums only) }. */
  private stateOf(messageId: string, prev?: { media?: MediaAttachment; attachments?: MediaAttachment[] } | null): MediaUpdateEvent | null {
    const list = this.itemsOfMessage(messageId).map((r) => this.toAttachment(r));
    if (list.length) return { messageId, media: list[0], ...(list.length > 1 || prev?.attachments ? { attachments: list } : {}) };
    const t = this.tombs.get(messageId);
    return t ? { messageId, media: this.goneAttachment(t, prev?.media) } : null;
  }

  /** Push a message's attachment state into the store and to every member (a single item or the whole album). */
  private publishMessage(conversationId: string | null, messageId: string, text?: string) {
    if (!conversationId) return;
    const m = store.findDm(conversationId, messageId);
    const ev = this.stateOf(messageId, m);
    if (!ev) return;
    store.patchDmMedia(conversationId, messageId, ev.media, text, ev.attachments ?? null);
    this.broadcast({ conversationId }, { ...ev, ...(text ? { text } : {}) });
  }

  // ---------- uploads ----------

  /** Delete a media folder and tell the media cache to drop it (no-op without MEDIA_CACHE_PURGE_URL). */
  private removeFiles(id: string) {
    fs.rmSync(this.dirOf(id), { recursive: true, force: true });
    purgeCache([`/media/${id}/`]);
  }

  private dirOf(id: string) {
    return path.join(MEDIA_DIR, id.slice(0, 2), id);
  }
  private tmpOf(id: string) {
    return path.join(TMP_DIR, `${id}.part`);
  }
  private saveSession(s: UploadSession) {
    fs.writeFileSync(path.join(TMP_DIR, `${s.id}.json`), JSON.stringify(s));
  }
  private dropSession(id: string) {
    this.sessions.delete(id);
    fs.rmSync(this.tmpOf(id), { force: true });
    fs.rmSync(path.join(TMP_DIR, `${id}.json`), { force: true });
  }
  private received(id: string) {
    try {
      return fs.statSync(this.tmpOf(id)).size;
    } catch {
      return 0;
    }
  }

  createUpload(ownerId: string, body: Record<string, unknown>) {
    const kind = String(body.kind ?? "") as MediaKind;
    if (!MEDIA_KINDS.includes(kind)) throw new MediaError("Unsupported attachment type");
    const size = Number(body.size);
    if (!Number.isInteger(size) || size <= 0) throw new MediaError("Empty file");
    const cap = MEDIA_LIMITS[kind];
    if (size > cap) throw new MediaError(`${kind === "photo" ? "Photos" : kind === "video" ? "Videos" : kind === "voice" ? "Voice messages" : "Files"} can be up to ${Math.round(cap / 1024 / 1024)} MB`, 413);
    if ((kind === "video" || kind === "voice") && !this.ffmpeg) throw new MediaError("Video and voice messages are temporarily unavailable", 503);
    const now = Date.now();
    const recent = (this.uploadRate.get(ownerId) ?? []).filter((t) => now - t < 600_000);
    if (recent.length >= UPLOADS_PER_10MIN) throw new MediaError("Too many uploads. Try again in a few minutes.", 429);
    const open = [...this.sessions.values()].filter((s) => s.ownerId === ownerId);
    if (open.length >= MAX_OPEN_UPLOADS) {
      // drop the oldest abandoned one instead of refusing (tabs closed mid-upload)
      const oldest = open.sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (now - oldest.updatedAt > 60_000) this.dropSession(oldest.id);
      else throw new MediaError("Too many uploads at once", 429);
    }
    const { freeBytes } = this.disk();
    // room for the upload + its processed copy, and the reserve
    if (freeBytes - DISK_RESERVE_BYTES < size * 2) {
      metrics.inc("media_disk_full_total");
      log.warn("media disk full", { freeBytes, size });
      throw new MediaError("Storage is full right now. Try a smaller file.", 507);
    }
    recent.push(now);
    this.uploadRate.set(ownerId, recent);
    const s: UploadSession = {
      id: randomUUID().replace(/-/g, ""),
      ownerId,
      kind,
      name: safeName(body.name, kind === "voice" ? "voice" : "file"),
      size,
      declaredMime: String(body.mime ?? "").slice(0, 100),
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(s.id, s);
    fs.writeFileSync(this.tmpOf(s.id), "");
    this.saveSession(s);
    return { uploadId: s.id, received: 0, size, chunkSize: CHUNK_DEFAULT_BYTES, maxChunk: CHUNK_MAX_BYTES };
  }

  private session(ownerId: string, id: string) {
    const s = ID_RE.test(id) ? this.sessions.get(id) : undefined;
    if (!s || s.ownerId !== ownerId) throw new MediaError("Upload not found", 404);
    return s;
  }

  uploadStatus(ownerId: string, id: string) {
    const s = this.session(ownerId, id);
    return { uploadId: s.id, received: this.received(id), size: s.size };
  }

  cancelUpload(ownerId: string, id: string) {
    const s = this.session(ownerId, id);
    this.dropSession(s.id);
    return { cancelled: true };
  }

  /** Append one chunk at `offset` (must equal what we have → resumable, idempotent on retries). */
  async putChunk(ownerId: string, id: string, offset: number, req: IncomingMessage) {
    const s = this.session(ownerId, id);
    if (this.busy.has(id)) throw new MediaError("Upload busy", 409);
    const have = this.received(id);
    if (!Number.isInteger(offset) || offset !== have) return { status: 409, body: { ok: false, error: "offset", received: have } };
    const declared = Number(req.headers["content-length"] ?? NaN);
    if (Number.isFinite(declared) && (declared > CHUNK_MAX_BYTES || have + declared > s.size)) throw new MediaError("Chunk too large", 413);
    this.busy.add(id);
    try {
      const fd = fs.openSync(this.tmpOf(id), "a");
      let wrote = 0;
      let first: Buffer | null = offset === 0 ? Buffer.alloc(0) : null;
      try {
        await new Promise<void>((resolve, reject) => {
          req.on("data", (d: Buffer) => {
            wrote += d.length;
            if (wrote > CHUNK_MAX_BYTES || have + wrote > s.size) {
              req.pause();
              reject(new MediaError("Chunk too large", 413));
              return;
            }
            if (first && first.length < 4096) first = Buffer.concat([first, d.subarray(0, 4096 - first.length)]);
            fs.writeSync(fd, d);
          });
          req.on("end", () => resolve());
          req.on("error", reject);
          req.on("aborted", () => reject(new MediaError("aborted", 400)));
        });
      } catch (e) {
        fs.closeSync(fd);
        // roll back a partial chunk so the client can retry from `have`
        fs.truncateSync(this.tmpOf(id), have);
        throw e;
      }
      fs.closeSync(fd);
      if (first && first.length) {
        // reject the wrong kind early (before the whole file is uploaded)
        const sn = sniff(first, s.name);
        s.sniffed = sn.mime;
        const bad =
          (s.kind === "photo" && sn.family !== "image") ||
          (s.kind === "video" && sn.family !== "video" && sn.mime !== "image/gif") ||
          (s.kind === "voice" && sn.family !== "audio" && sn.family !== "video");
        if (bad) {
          this.dropSession(id);
          throw new MediaError(s.kind === "photo" ? "That file isn't a photo. Send it as a file instead." : s.kind === "video" ? "That file isn't a video. Send it as a file instead." : "Unsupported recording format", 415);
        }
      }
      s.updatedAt = Date.now();
      this.saveSession(s);
      return { status: 200, body: { ok: true, received: have + wrote, size: s.size } };
    } finally {
      this.busy.delete(id);
    }
  }

  /** All bytes are in: validate + process into a media row (not sent yet). */
  async complete(ownerId: string, id: string) {
    const s = this.session(ownerId, id);
    if (this.busy.has(id)) throw new MediaError("Upload busy", 409);
    const have = this.received(id);
    if (have !== s.size) return { status: 409, body: { ok: false, error: "incomplete", received: have, size: s.size } };
    this.busy.add(id);
    const mediaId = randomUUID().replace(/-/g, "");
    const dir = this.dirOf(mediaId);
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, "upload.bin");
    try {
      fs.renameSync(this.tmpOf(id), src);
      fs.rmSync(path.join(TMP_DIR, `${id}.json`), { force: true });
      this.sessions.delete(id);
      const head = Buffer.alloc(4096);
      const fd = fs.openSync(src, "r");
      const n = fs.readSync(fd, head, 0, 4096, 0);
      fs.closeSync(fd);
      const sn = sniff(head.subarray(0, n), s.name);
      const now = Date.now();
      const row: MediaRow = {
        id: mediaId,
        ownerId,
        conversationId: null,
        messageId: null,
        kind: s.kind,
        mime: sn.mime,
        name: s.name,
        size: s.size,
        width: null,
        height: null,
        durationMs: null,
        waveform: null,
        placeholder: null,
        gif: false,
        files: {},
        status: "ready",
        label: true,
        ttlSeconds: null,
        viewOnce: false,
        expiresAt: null,
        openedAt: null,
        playedAt: null,
        createdAt: now,
        sentAt: null,
        position: 0,
        rev: 1,
      };
      const t0 = Date.now();
      await this.process(row, src, dir, sn.mime, sn.family);
      metrics.inc(`media_processed_${row.kind}_total`);
      log.info("media processed", { id: mediaId, kind: row.kind, mime: row.mime, bytes: row.size, ms: Date.now() - t0, status: row.status });
      this.rows.set(row.id, row);
      await this.repo!.insert(row);
      if (row.status === "processing") void this.finishVideo(row).catch(() => {});
      else if (this.wantsHls(row)) void this.buildHls(row).catch(() => {});
      return { status: 200, body: { ok: true, media: this.toAttachment(row) } };
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    } finally {
      this.busy.delete(id);
    }
  }

  /** srcset thumbnails when they were made (AVIF can fail on odd inputs: WebP alone is fine) */
  private extraThumbs(dir: string) {
    const out: Record<string, { file: string; mime: string; size: number }> = {};
    const add = (k: string, file: string, mime: string) => fs.existsSync(path.join(dir, file)) && (out[k] = this.fileEntry(dir, file, mime));
    add("thumbS", "thumb-320.webp", "image/webp");
    add("thumbAvif", "thumb-640.avif", "image/avif");
    add("thumbSAvif", "thumb-320.avif", "image/avif");
    return out;
  }

  private fileEntry(dir: string, file: string, mime: string) {
    return { file, mime, size: fs.statSync(path.join(dir, file)).size };
  }

  private async process(row: MediaRow, src: string, dir: string, mime: string, family: string) {
    if (row.kind === "photo") {
      if (family !== "image") throw new MediaError("That file isn't a photo. Send it as a file instead.", 415);
      if (mime === "image/gif" && (await gifFrames(src)) > 1) {
        // animated GIF → Telegram-style silent looping mp4 (the GIF itself is shown until the mp4 is ready)
        if (!this.ffmpeg) throw new MediaError("GIFs are temporarily unavailable", 503);
        fs.renameSync(src, path.join(dir, "original.gif"));
        const meta = await (await import("sharp")).default(path.join(dir, "original.gif")).metadata();
        await (await import("sharp")).default(path.join(dir, "original.gif"), { pages: 1 }).resize(640, 640, { fit: "inside", withoutEnlargement: true }).webp({ quality: 72 }).toFile(path.join(dir, "poster.webp"));
        Object.assign(row, {
          kind: "video",
          gif: true,
          mime: "image/gif",
          width: meta.width ?? null,
          height: meta.pageHeight ?? meta.height ?? null,
          placeholder: await placeholderFrom(path.join(dir, "poster.webp")),
          status: "processing",
          files: { original: this.fileEntry(dir, "original.gif", "image/gif"), poster: this.fileEntry(dir, "poster.webp", "image/webp") },
        });
        return;
      }
      const srcMeta = KEEP_ORIGINALS && (mime === "image/jpeg" || mime === "image/png") ? await (await import("sharp")).default(src, { failOn: "none" }).metadata().catch(() => null) : null;
      const out = await processImage(src, dir, mime);
      // Telegram-style original download: the sender's pixels, metadata stripped losslessly (see original.ts)
      let source: { file: string; mime: string; size: number } | null = null;
      if (srcMeta?.width && srcMeta.height) {
        try {
          source = keepOriginalPhoto(src, dir, mime, { orientation: srcMeta.orientation, srcW: srcMeta.width, srcH: srcMeta.height, fullW: out.width, fullH: out.height, fullBytes: fs.statSync(path.join(dir, `full.${out.ext}`)).size });
        } catch {
          source = null;
        }
      }
      fs.rmSync(src, { force: true });
      Object.assign(row, {
        mime: out.mime,
        width: out.width,
        height: out.height,
        placeholder: out.placeholder,
        files: { full: this.fileEntry(dir, `full.${out.ext}`, out.mime), thumb: this.fileEntry(dir, "thumb.webp", "image/webp"), ...this.extraThumbs(dir), ...(source ? { source } : {}) },
      });
      return;
    }
    if (row.kind === "video") {
      if (family !== "video") throw new MediaError("That file isn't a video. Send it as a file instead.", 415);
      const out = await processVideo(src, dir);
      const files: MediaRow["files"] = { poster: this.fileEntry(dir, "poster.webp", "image/webp") };
      if (out.playable) {
        fs.rmSync(src, { force: true });
        files.full = this.fileEntry(dir, "full.mp4", "video/mp4");
      } else {
        const ext = mime === "video/webm" ? "webm" : mime === "video/quicktime" ? "mov" : "mp4";
        fs.renameSync(src, path.join(dir, `original.${ext}`));
        files.original = this.fileEntry(dir, `original.${ext}`, mime);
      }
      Object.assign(row, { mime: "video/mp4", width: out.width, height: out.height, durationMs: out.durationMs, placeholder: out.placeholder, files, status: out.playable ? "ready" : "processing" });
      return;
    }
    if (row.kind === "voice") {
      if (family !== "audio" && family !== "video") throw new MediaError("Unsupported recording format", 415);
      const out = await processVoice(src, dir);
      fs.rmSync(src, { force: true });
      Object.assign(row, { mime: "audio/mp4", durationMs: out.durationMs, waveform: out.waveform, name: null, files: { full: this.fileEntry(dir, "full.m4a", "audio/mp4") } });
      row.size = row.files.full.size;
      return;
    }
    // document: stored as uploaded (byte-for-byte), served with the sniffed type; images also get a thumbnail
    const ext = (row.name?.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin";
    fs.renameSync(src, path.join(dir, `file.${ext}`));
    row.files = { full: this.fileEntry(dir, `file.${ext}`, mime) };
    if (family === "image" && mime !== "image/heic" && mime !== "image/heif") {
      try {
        const s = (await import("sharp")).default;
        const meta = await s(path.join(dir, `file.${ext}`), { failOn: "none" }).metadata();
        await s(path.join(dir, `file.${ext}`), { failOn: "none" }).rotate().resize(320, 320, { fit: "inside", withoutEnlargement: true }).webp({ quality: 70 }).toFile(path.join(dir, "thumb.webp"));
        row.files.thumb = this.fileEntry(dir, "thumb.webp", "image/webp");
        row.placeholder = await placeholderFrom(path.join(dir, "thumb.webp"));
        row.width = meta.width ?? null;
        row.height = meta.height ?? null;
      } catch {}
    }
  }

  /** Background transcode for videos that couldn't be remuxed (HEVC, VP9, …) and animated GIFs. */
  private async finishVideo(row: MediaRow) {
    const orig = row.files.original;
    if (!orig) return;
    const dir = this.dirOf(row.id);
    try {
      // playable early: the 240p rung comes first, then the rest of the ladder, then the MP4 fallback
      if (this.wantsHls(row)) await this.buildHls(row).catch(() => {});
      if (!this.rows.has(row.id)) return;
      const out = await transcodeVideo(path.join(dir, orig.file), dir, { gif: row.gif });
      if (!this.rows.has(row.id)) return fs.rmSync(dir, { recursive: true, force: true }); // expired/deleted meanwhile
      // keep the sender's original streams (stream copy, metadata stripped) as the "Download original" file
      const ext = orig.file.split(".").pop() ?? "mp4";
      const srcFile = KEEP_ORIGINALS && !row.gif ? await keepOriginalVideo(path.join(dir, orig.file), dir, ext) : null;
      fs.rmSync(path.join(dir, orig.file), { force: true });
      const files = { ...row.files, full: this.fileEntry(dir, "full.mp4", "video/mp4"), ...(srcFile ? { source: this.fileEntry(dir, srcFile, orig.mime) } : {}) };
      delete (files as Record<string, unknown>).original;
      Object.assign(row, { files, status: "ready", mime: "video/mp4", width: out.width, height: out.height, durationMs: out.durationMs || row.durationMs });
      await this.repo!.update(row.id, { files: row.files, status: row.status, mime: row.mime, width: row.width, height: row.height, durationMs: row.durationMs });
      this.publish(row);
    } catch (err) {
      log.warn("media transcode failed", { id: row.id, err });
      if (!this.rows.has(row.id)) return;
      // keep the original as a download; the client offers "Download" instead of the player
      row.status = "failed";
      await this.repo!.update(row.id, { status: "failed" }).catch(() => {});
      this.publish(row);
    }
  }

  // ---------- sending ----------

  /** Send one attachment, or an album (2–10 photos/videos, `mediaIds` in order) as ONE message. */
  send(fromId: string, body: Record<string, unknown>) {
    const raw = Array.isArray(body.mediaIds) ? body.mediaIds : [body.mediaId];
    const ids = [...new Set(raw.map((x) => String(x ?? "")))];
    if (!ids.length || ids.length > ALBUM_MAX) throw new MediaError(`Albums can have up to ${ALBUM_MAX} photos and videos`, 400);
    const rows = ids.map((id) => (ID_RE.test(id) ? this.rows.get(id) : undefined));
    if (rows.some((r) => !r || r.ownerId !== fromId)) throw new MediaError("Attachment not found. Try attaching it again.", 404);
    const items = rows as MediaRow[];
    const to = String(body.to ?? "");
    // groups: same attachments, sent through the group fan-out (store.sendMediaDm → groups.sendMedia); view once is 1:1 only
    const inGroup = isGroupId(to);
    if (inGroup && body.viewOnce === true) throw new MediaError("View once is only for 1:1 chats", 400);
    const already = items.find((r) => r.messageId);
    if (already) {
      // retried send (lost ack) → same message
      const m = already.conversationId ? store.findDm(already.conversationId, already.messageId!) : null;
      if (m && items.every((r) => r.messageId === already.messageId)) return { ok: true as const, message: m };
      throw new MediaError("Attachment already sent", 409);
    }
    const album = items.length > 1;
    if (album && items.some((r) => r.kind !== "photo" && r.kind !== "video")) throw new MediaError("Albums hold photos and videos. Send files on their own.", 400);
    // view once is a single photo/video; an album's timer applies to every item
    const viewOnce = !album && body.viewOnce === true && (items[0].kind === "photo" || items[0].kind === "video");
    let ttl = Math.floor(Number(body.ttlSeconds ?? 0));
    if (!Number.isFinite(ttl) || ttl < 0) ttl = 0;
    if (ttl) ttl = Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, ttl));
    const expiring = viewOnce || ttl > 0;
    // self-destructing media carries no caption (pushes and previews only ever say "📷 Photo")
    const caption = expiring ? "" : String(body.caption ?? "").trim().slice(0, 2000);
    const now = Date.now();
    items.forEach((r, i) => {
      r.ttlSeconds = ttl || null;
      r.viewOnce = viewOnce;
      // the timer starts at send; view once also has a hard cap (the timer, or 30 days)
      r.expiresAt = ttl ? now + ttl * 1000 : viewOnce ? now + MAX_TTL_SECONDS * 1000 : null;
      r.label = !caption;
      r.position = i;
    });
    const list = items.map((r) => this.toAttachment(r));
    const text = caption || (album ? albumLabel(list) : mediaLabel(list[0]));
    const res = store.sendMediaDm(fromId, to, text, body.clientId, list[0], album ? list : undefined, body.replyToId);
    if (!res.ok || res.duplicate) {
      for (const r of items) Object.assign(r, { ttlSeconds: null, viewOnce: false, expiresAt: null, position: 0 });
      return res;
    }
    const conversationId = inGroup ? convKey(fromId, to) : [fromId, to].sort().join("|");
    for (const r of items) {
      r.messageId = res.message.id;
      r.conversationId = conversationId;
      r.sentAt = res.message.createdAt;
      this.link(r);
      void this.repo!.update(r.id, { messageId: r.messageId, conversationId, sentAt: r.sentAt, ttlSeconds: r.ttlSeconds, viewOnce: r.viewOnce, expiresAt: r.expiresAt, label: r.label, position: r.position }).catch((err) =>
        log.error("media send persist failed", { id: r.id, err }),
      );
      if (r.expiresAt) this.schedule(r);
    }
    metrics.inc(album ? "media_album_sent_total" : "media_sent_total");
    return { ok: true as const, message: res.message };
  }

  // ---------- signed URLs ----------

  private sig(id: string, variant: string, viewer: string, exp: number) {
    return createHmac("sha256", this.secret).update(`${id}.${variant}.${viewer}.${exp}`).digest("base64url");
  }

  url(id: string, variant: string, viewer: string, now = Date.now(), opts: { dl?: boolean; exact?: boolean } = {}) {
    // rounded expiry → the same URL for a few minutes → browser cache hits while scrolling back and forth
    const nowS = Math.floor(now / 1000);
    const exp = opts.exact ? nowS + URL_TTL_S : Math.ceil((nowS + URL_TTL_S) / URL_WINDOW_S) * URL_WINDOW_S;
    return `/api/media/f/${id}/${variant}?u=${encodeURIComponent(viewer)}&e=${exp}&s=${this.sig(id, variant, viewer, exp)}${opts.dl ? "&dl=1" : ""}`;
  }

  /** Link lifetime: timer/view-once media exact + short; videos cover the clip + 15 min; rounded so URLs repeat. */
  private expFor(r: MediaRow, now = Date.now()) {
    const nowS = Math.floor(now / 1000);
    if (r.expiresAt || r.viewOnce) return nowS + URL_TTL_S;
    const ttl = r.kind === "video" ? Math.max(URL_TTL_S, Math.ceil((r.durationMs ?? 0) / 1000) + HLS_URL_EXTRA_S) : URL_TTL_S;
    return Math.ceil((nowS + ttl) / URL_WINDOW_S) * URL_WINDOW_S;
  }

  /** Signed `/media/<id>/v<rev>/<file>` URL (MEDIA_CDN_BASE unless the media is private-by-time). */
  private fileUrl(r: MediaRow, variant: string, viewerId: string, now = Date.now(), opts: { dl?: boolean } = {}) {
    const f = r.files[variant];
    if (!f) return null;
    return signedUrl(r.id, r.rev ?? 1, f.file, viewerId, this.expFor(r, now), { origin: !!(r.expiresAt || r.viewOnce), dl: opts.dl });
  }

  /** Signed URLs for the variants the viewer may load now. View-once full files only come from open(). */
  sign(viewerId: string, items: unknown) {
    const out: Record<string, Partial<Record<MediaVariant, string>> & { gone?: boolean }> = {};
    const list = Array.isArray(items) ? items.slice(0, 100) : [];
    const now = Date.now();
    for (const it of list) {
      const id = String((it as { id?: unknown })?.id ?? "");
      const want = ((it as { v?: unknown })?.v as unknown[]) ?? ["thumb"];
      const r = ID_RE.test(id) ? this.rows.get(id) : undefined;
      if (!r || !this.canView(viewerId, r, now)) {
        out[id] = { gone: true };
        continue;
      }
      const urls: Partial<Record<MediaVariant, string>> = {};
      for (const v of Array.isArray(want) ? want : []) {
        if (!VARIANTS.includes(v as MediaVariant)) continue;
        let variant = v as MediaVariant;
        if (variant === "full" && !r.files.full && r.files.original) variant = "original"; // still processing
        if (!r.files[variant]) continue;
        if (r.viewOnce) continue; // view once: nothing loads until the recipient opens it
        if ((variant === "hls" || variant === "hlsLow") && isTimed(r)) continue; // timed: MP4 from the origin only
        if (variant === "source" && isTimed(r)) continue; // self-destructing media is never saved
        const u = this.fileUrl(r, variant, viewerId, now);
        if (u) urls[v as MediaVariant] = u;
      }
      out[id] = urls;
    }
    return { urls: out };
  }

  /** Resolve a verified /media/<id>/v<rev>/<rest> request (contract §2/§4). Access is re-checked every time. */
  originFile(uid: string, id: string, rev: number, rest: string): OriginFile | { status: 404 | 403 } {
    const r = ID_RE.test(id) ? this.rows.get(id) : undefined;
    if (!r || (r.rev ?? 1) !== rev || !this.canView(uid, r)) return { status: 404 };
    if (r.viewOnce && !(uid !== r.ownerId && r.openedAt)) return { status: 404 };
    const timed = !!(r.expiresAt || r.viewOnce);
    const dir = this.dirOf(id);
    const hls = HLS_PATH_RE.exec(rest);
    if (hls) {
      if (timed || !r.files.hls?.rungs?.includes(Number(hls[1]))) return { status: 404 };
      const file = path.join(dir, rest);
      if (hls[2] === "index.m3u8") {
        let ended = false;
        try {
          ended = fs.readFileSync(file, "utf8").includes("#EXT-X-ENDLIST");
        } catch {
          return { status: 404 };
        }
        return { file, mime: HLS_MIME, playlist: true, cache: ended ? IMMUTABLE : "public, max-age=5, stale-while-revalidate=5" };
      }
      return { file, mime: hls[2] === "init.mp4" ? "video/mp4" : "video/iso.segment", cache: IMMUTABLE };
    }
    const entry = Object.entries(r.files).find(([, f]) => f.file === rest);
    if (!entry) return { status: 404 };
    const [variant, f] = entry;
    if (r.viewOnce && variant !== "full" && variant !== "original" && variant !== "poster") return { status: 404 };
    if (variant === "hls" || variant === "hlsLow") {
      if (timed) return { status: 404 };
      return { file: path.join(dir, f.file), mime: HLS_MIME, playlist: true, cache: r.files.hls?.final ? IMMUTABLE : "public, max-age=10, stale-while-revalidate=10" };
    }
    const inlineOk = INLINE_SAFE.has(f.mime) || f.mime === "image/webp" || f.mime === "image/avif" || f.mime === "video/webm" || f.mime === "video/quicktime";
    const name = r.name || `${r.kind}-${id.slice(0, 8)}.${f.file.split(".").pop()}`;
    // "source" (Download original) is only ever a download: always attachment. Disposition can't follow ?dl=1 here,
    // the edge caches by path only.
    const dl = variant === "source" || !inlineOk || (r.kind === "document" && !(f.mime === "application/pdf" || f.mime.startsWith("image/")) && variant === "full");
    return {
      file: path.join(dir, f.file),
      mime: inlineOk ? f.mime : "application/octet-stream",
      cache: timed ? "no-store" : IMMUTABLE,
      disposition: `${dl ? "attachment" : "inline"}; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    };
  }

  // ---------- adaptive video (HLS ladder) ----------

  private wantsHls(r: MediaRow) {
    return HLS_ENABLED && this.ffmpeg && r.kind === "video" && !r.gif && !isTimed(r) && (r.durationMs ?? 0) > 0 && (r.durationMs ?? 0) <= HLS_MAX_MS;
  }

  /**
   * Build the ladder on the background queue: 240p alone first (playable early; status flips to ready for videos
   * that were still transcoding), then every higher rung in one multi-output pass, then the final masters.
   */
  async buildHls(row: MediaRow, opts: { restart?: boolean } = {}) {
    return hlsQueue.run(async () => {
      if (!this.rows.has(row.id) || row.files.hls?.final) return;
      const dir = this.dirOf(row.id);
      const srcFile = row.files.full?.file ?? row.files.original?.file;
      if (!srcFile) return;
      const src = path.join(dir, srcFile);
      const hlsDir = path.join(dir, "hls");
      const t0 = Date.now();
      try {
        if (opts.restart || fs.existsSync(hlsDir)) {
          fs.rmSync(hlsDir, { recursive: true, force: true });
          if (row.files.hls) {
            // something was already published under this rev: move to a new one so caches never mix versions
            const oldRev = row.rev ?? 1;
            row.rev = oldRev + 1;
            // reprocess: the old version's URLs are dead at the origin; tell the media cache to drop its copies too
            purgeCache([`/media/${row.id}/v${oldRev}/`]);
            const files = { ...row.files };
            delete files.hls;
            delete files.hlsLow;
            row.files = files;
            await this.repo!.update(row.id, { rev: row.rev, files: row.files });
          }
        }
        fs.mkdirSync(hlsDir, { recursive: true });
        const p = await probeVideo(src);
        if (!p.video) return;
        const ladder = ladderFor(p);
        const done: RungInfo[] = [];
        const publishRungs = async (final: boolean) => {
          if (!this.rows.has(row.id)) throw new Error("gone");
          writeMasters(hlsDir, done);
          const rungs = done.map((x) => x.r).sort((a, b) => a - b);
          const files = {
            ...row.files,
            hls: { ...this.fileEntry(dir, "hls/master.m3u8", HLS_MIME), rungs, final },
            hlsLow: { ...this.fileEntry(dir, "hls/master-low.m3u8", HLS_MIME), rungs, final },
          };
          const patch: Partial<MediaRow> = { files };
          if (row.status === "processing") patch.status = "ready";
          Object.assign(row, patch);
          await this.repo!.update(row.id, patch);
          this.publish(row);
        };
        await encodeRungs(src, hlsDir, [ladder[0]], p);
        done.push(await rungInfo(hlsDir, ladder[0], !!p.audio));
        await publishRungs(ladder.length === 1);
        log.info("media hls first rung", { id: row.id, rung: ladder[0], ms: Date.now() - t0 });
        if (ladder.length > 1) {
          await encodeRungs(src, hlsDir, ladder.slice(1), p);
          for (const r of ladder.slice(1)) done.push(await rungInfo(hlsDir, r, !!p.audio));
          await publishRungs(true);
        }
        metrics.inc("media_hls_ready_total");
        log.info("media hls ready", { id: row.id, rungs: done.map((x) => x.r), ms: Date.now() - t0, durMs: p.durationMs });
      } catch (err) {
        if (!this.rows.has(row.id)) return void fs.rmSync(hlsDir, { recursive: true, force: true });
        log.warn("media hls failed", { id: row.id, err: String(err).slice(0, 400) });
        // keep what's playable; mark the ladder final so it isn't retried forever
        if (row.files.hls) {
          row.files = { ...row.files, hls: { ...row.files.hls, final: true }, ...(row.files.hlsLow ? { hlsLow: { ...row.files.hlsLow, final: true } } : {}) };
          await this.repo!.update(row.id, { files: row.files }).catch(() => {});
        }
      }
    });
  }

  // ---------- file serving ----------

  async serve(req: IncomingMessage, res: ServerResponse, id: string, variant: string, q: URLSearchParams) {
    const viewer = q.get("u") ?? "";
    const exp = Number(q.get("e"));
    const s = q.get("s") ?? "";
    const fail = (code: number) => {
      res.writeHead(code, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end(code === 404 ? "Not found" : "Link expired");
    };
    if (!ID_RE.test(id) || !VARIANTS.includes(variant as MediaVariant)) return fail(404);
    const want = this.sig(id, variant, viewer, exp);
    if (!s || s.length !== want.length || !timingSafeEqual(Buffer.from(s), Buffer.from(want))) return fail(403);
    if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return fail(403);
    const r = this.rows.get(id);
    if (!r || !this.canView(viewer, r)) return fail(404);
    if (r.viewOnce && !(viewer !== r.ownerId && r.openedAt)) return fail(404);
    const f = r.files[variant];
    if (!f) return fail(404);
    const file = path.join(this.dirOf(id), f.file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return fail(404);
    }
    const inlineOk = INLINE_SAFE.has(f.mime) || f.mime === "image/webp" || f.mime === "video/webm" || f.mime === "video/quicktime";
    const type = inlineOk ? f.mime : "application/octet-stream";
    const name = r.name || `${r.kind}-${id.slice(0, 8)}.${f.file.split(".").pop()}`;
    const dl = q.get("dl") === "1" || !inlineOk || r.kind === "document" && !(f.mime === "application/pdf" || f.mime.startsWith("image/")) ;
    const headers: Record<string, string> = {
      "Content-Type": type,
      "Accept-Ranges": "bytes",
      "Cache-Control": r.expiresAt ? "no-store" : `private, max-age=${Math.max(0, Math.min(URL_TTL_S, exp - Math.floor(Date.now() / 1000)))}, immutable`,
      "Content-Disposition": `${dl ? "attachment" : "inline"}; filename="${name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      // never let an uploaded file act as a page on our origin
      "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    };
    if (r.expiresAt) headers.Pragma = "no-cache";
    else if (applyValidators(req, stat, headers) && !req.headers.range) {
      res.writeHead(304, notModifiedHeaders(headers)).end();
      return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      } else start = Math.max(0, stat.size - Number(range[2]));
      if (start > end || start >= stat.size) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Cache-Control": "no-store" }).end();
        return;
      }
      status = 206;
      headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers["Content-Length"] = String(end - start + 1);
    res.writeHead(status, headers);
    if (req.method === "HEAD") return void res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }

  // ---------- view once / played / delete now ----------

  private sentRow(viewerId: string, id: string) {
    const r = ID_RE.test(id) ? this.rows.get(id) : undefined;
    if (!r || !r.messageId) throw new MediaError("This media is no longer available", 410);
    if (!this.canView(viewerId, r)) throw new MediaError("This media is no longer available", 410);
    return r;
  }

  /** Recipient opens a view-once photo/video: one signed URL, and the clock runs (deleted on close or after the grace). */
  async open(viewerId: string, id: string) {
    const r = this.sentRow(viewerId, id);
    if (!r.viewOnce) return { urls: this.sign(viewerId, [{ id, v: ["full", "poster", "thumb"] }]).urls[id] };
    if (viewerId === r.ownerId) throw new MediaError("You sent this as view once", 403);
    const now = Date.now();
    if (r.openedAt && now - r.openedAt > VIEW_ONCE_GRACE_MS + (r.durationMs ?? 0)) throw new MediaError("Already viewed", 410);
    if (!r.openedAt) {
      r.openedAt = now;
      r.expiresAt = Math.min(r.expiresAt ?? Infinity, now + VIEW_ONCE_GRACE_MS + (r.durationMs ?? 0));
      await this.repo!.update(r.id, { openedAt: r.openedAt, expiresAt: r.expiresAt });
      this.schedule(r);
      this.publish(r);
    }
    const variant = r.files.full ? "full" : r.files.original ? "original" : null;
    if (!variant) throw new MediaError("Still processing. Try again in a moment.", 409);
    const urls: Partial<Record<MediaVariant, string>> = { full: this.fileUrl(r, variant, viewerId, now)! };
    if (r.files.poster) urls.poster = this.fileUrl(r, "poster", viewerId, now)!;
    return { urls };
  }

  /** Recipient closed the view-once viewer → gone for both. */
  async viewed(viewerId: string, id: string) {
    const r = ID_RE.test(id) ? this.rows.get(id) : undefined;
    if (!r) return { ok: true };
    if (!r.viewOnce || viewerId === r.ownerId || !this.members(r.conversationId).includes(viewerId) || !r.openedAt) throw new MediaError("Not allowed", 403);
    await this.expire(r, "viewed");
    return { ok: true };
  }

  async played(viewerId: string, id: string) {
    const r = this.sentRow(viewerId, id);
    if (viewerId === r.ownerId || r.playedAt) return { ok: true };
    r.playedAt = Date.now();
    await this.repo!.update(r.id, { playedAt: r.playedAt });
    this.publish(r);
    return { ok: true };
  }

  /** Sender's "Delete now": file + row removed, both sides see "Photo deleted". */
  async deleteNow(userId: string, id: string, opts: { all?: boolean } = {}) {
    const r = ID_RE.test(id) ? this.rows.get(id) : undefined;
    if (!r) return { ok: true };
    if (r.ownerId !== userId) throw new MediaError("Only the sender can delete this", 403);
    // one item of an album, or (all) every item of the message
    const targets = opts.all && r.messageId ? this.itemsOfMessage(r.messageId) : [r];
    for (const t of targets) await this.expire(t, "deleted");
    return { ok: true };
  }

  /** Current attachment state for messages a reconnecting client has on screen. */
  reconcile(viewerId: string, messageIds: unknown) {
    const ids = Array.isArray(messageIds) ? messageIds.filter((x): x is string => typeof x === "string").slice(0, 500) : [];
    const items: MediaUpdateEvent[] = [];
    for (const mid of ids) {
      const conv = this.itemsOfMessage(mid)[0]?.conversationId ?? this.tombs.get(mid)?.conversationId ?? null;
      if (!conv || !this.members(conv).includes(viewerId)) continue;
      const ev = this.stateOf(mid, store.findDm(conv, mid));
      if (ev) items.push(ev);
    }
    return { items };
  }

  // ---------- expiry ----------

  private schedule(r: MediaRow) {
    clearTimeout(this.timers.get(r.id));
    this.timers.delete(r.id);
    if (!r.expiresAt) return;
    const delay = r.expiresAt - Date.now();
    // long timers are left to the sweeper (setTimeout caps at ~24.8 days anyway)
    if (delay > SWEEP_MS * 4) return;
    const t = setTimeout(() => void this.expire(r, r.viewOnce && r.openedAt ? "viewed" : "expired").catch((err) => log.warn("media expire failed", { id: r.id, err })), Math.max(0, delay));
    t.unref?.();
    this.timers.set(r.id, t);
  }

  /** Delete the file and the media row; leave a tombstone; tell both sides. Idempotent. */
  async expire(r: MediaRow, reason: MediaGoneReason) {
    if (!this.rows.has(r.id)) return;
    if (process.env.MEDIA_SWEEP_DRY_RUN === "1") return void log.info("media expire dry-run", { id: r.id, reason, kind: r.kind });
    this.rows.delete(r.id);
    clearTimeout(this.timers.get(r.id));
    this.timers.delete(r.id);
    this.removeFiles(r.id);
    await this.repo!.remove(r.id).catch((err) => log.error("media row delete failed", { id: r.id, err }));
    metrics.inc(`media_gone_${reason}_total`);
    if (!r.messageId) return;
    this.unlink(r);
    const rest = this.itemsOfMessage(r.messageId);
    const msg = r.conversationId ? store.findDm(r.conversationId, r.messageId) : null;
    let text: string | undefined;
    if (!rest.length) {
      // last (or only) item: leave a tombstone so the bubble says "Photo expired"; a caption goes with the file
      const t: Tombstone = { messageId: r.messageId, mediaId: r.id, conversationId: r.conversationId, kind: r.kind, gif: r.gif, viewOnce: r.viewOnce, reason, at: Date.now() };
      this.tombs.set(r.messageId, t);
      await this.repo!.tombstone(t).catch((err) => log.error("media tombstone failed", { id: r.id, err }));
      if (!r.label) text = msg?.attachments ? "🖼️ Album" : mediaLabel({ kind: r.kind, name: r.kind === "document" ? r.name ?? undefined : undefined, gif: r.gif });
    } else if (r.label) {
      // one item left an album: keep the auto label's counts right ("🖼️ Album · 2 photos")
      text = rest.length > 1 ? albumLabel(rest) : mediaLabel({ kind: rest[0].kind, gif: rest[0].gif });
    }
    this.publishMessage(r.conversationId, r.messageId, text);
    log.info("media gone", { id: r.id, reason, left: rest.length, kind: r.kind, timed: isTimed(r), bytes: Object.values(r.files).reduce((n, f) => n + (f?.size ?? 0), 0), variants: Object.keys(r.files) });
  }

  /** Periodic: due expiries, orphans (message deleted / trimmed / sender's account deleted), unsent + stale uploads. */
  /**
   * What a sweep would delete right now, without touching anything (dry-run + the circuit breaker below).
   * Media-free: ids, kinds, sizes and reasons only.
   */
  plan(now = Date.now()) {
    const out: { id: string; reason: "expired" | "viewed" | "owner-deleted" | "orphan" | "unsent"; kind: string; bytes: number; variants: string[]; timed: boolean }[] = [];
    const storeLoaded = store.users.size > 0;
    for (const r of this.rows.values()) {
      const base = { id: r.id, kind: r.kind, bytes: Object.values(r.files).reduce((n, f) => n + (f?.size ?? 0), 0), variants: Object.keys(r.files), timed: isTimed(r) };
      if (r.expiresAt && r.expiresAt <= now) out.push({ ...base, reason: r.viewOnce && r.openedAt ? "viewed" : "expired" });
      else if (!storeLoaded) continue;
      else if (!store.users.has(r.ownerId)) out.push({ ...base, reason: "owner-deleted" });
      else if (r.messageId && (r.conversationId?.includes("|") || isGroupId(r.conversationId)) && !store.findDm(r.conversationId!, r.messageId)) out.push({ ...base, reason: "orphan" });
      else if (!r.messageId && now - r.createdAt > UNSENT_TTL_MS) out.push({ ...base, reason: "unsent" });
    }
    return out;
  }

  async sweep(now = Date.now()) {
    // Guards. Due self-destruct expiries always run (that's the privacy promise). Everything else — orphans, files of
    // deleted accounts — is skipped while the chat store isn't loaded, and paused for this pass if an unusual number
    // would go at once (a bug or a half-loaded store must never mass-delete normal media). MEDIA_SWEEP_DRY_RUN=1
    // logs the plan and deletes nothing at all.
    const plan = this.plan(now);
    const nonTimed = plan.filter((p) => p.reason === "owner-deleted" || p.reason === "orphan").length;
    const dryRun = process.env.MEDIA_SWEEP_DRY_RUN === "1";
    const maxOrphans = Number(process.env.MEDIA_ORPHAN_SWEEP_MAX || 200);
    const orphansPaused = store.users.size === 0 || nonTimed > maxOrphans;
    if (nonTimed > maxOrphans) {
      metrics.inc("media_sweep_paused_total");
      log.error("media sweep: orphan deletion paused (too many at once)", { wouldDelete: nonTimed, max: maxOrphans });
    }
    if (dryRun) {
      const by: Record<string, { n: number; bytes: number }> = {};
      for (const p of plan) (by[p.reason] ??= { n: 0, bytes: 0 }), (by[p.reason].n++, (by[p.reason].bytes += p.bytes));
      log.info("media sweep dry-run", { by, orphansPaused });
      return plan;
    }
    for (const r of [...this.rows.values()]) {
      if (r.expiresAt && r.expiresAt <= now) {
        await this.expire(r, r.viewOnce && r.openedAt ? "viewed" : "expired");
        continue;
      }
      if (r.expiresAt && !this.timers.has(r.id)) this.schedule(r);
      if (orphansPaused) {
        if (!r.messageId && now - r.createdAt > UNSENT_TTL_MS && store.users.size > 0) {
          this.rows.delete(r.id);
          this.removeFiles(r.id);
          await this.repo!.remove(r.id).catch(() => {});
        }
        continue;
      }
      if (!store.users.has(r.ownerId)) {
        // account deleted: files they uploaded are erased; the bubble says "Photo deleted"
        await this.expire(r, "deleted");
        continue;
      }
      if (r.messageId && (r.conversationId?.includes("|") || isGroupId(r.conversationId)) && !store.findDm(r.conversationId!, r.messageId)) {
        // message deleted for everyone / trimmed from history: no tombstone needed, the bubble is gone
        this.rows.delete(r.id);
        this.unlink(r);
        this.removeFiles(r.id);
        await this.repo!.remove(r.id).catch(() => {});
        continue;
      }
      if (!r.messageId && now - r.createdAt > UNSENT_TTL_MS) {
        this.rows.delete(r.id);
        this.removeFiles(r.id);
        await this.repo!.remove(r.id).catch(() => {});
      }
    }
    for (const s of [...this.sessions.values()]) if (now - s.updatedAt > UPLOAD_STALE_MS) this.dropSession(s.id);
  }

  /** Conversation deleted by the chat layer (a group's last member left): remove every file sent in it. Idempotent. */
  async purgeConversation(conversationId: string) {
    await this.ready();
    const mids = new Set<string>();
    for (const r of this.rows.values()) if (r.conversationId === conversationId && r.messageId) mids.add(r.messageId);
    for (const mid of mids) await this.onMessageDeleted(mid);
    if (mids.size) log.info("media conversation purged", { conversationId, messages: mids.size });
  }

  /** Message deleted by the chat layer (delete for everyone): remove its file right away. */
  async onMessageDeleted(messageId: string) {
    for (const r of this.itemsOfMessage(messageId)) {
      this.rows.delete(r.id);
      clearTimeout(this.timers.get(r.id));
      this.timers.delete(r.id);
      this.removeFiles(r.id);
      await this.repo!.remove(r.id).catch(() => {});
    }
    this.byMessage.delete(messageId);
  }

  /**
   * The chat layer edited an attachment message's text (message editing): a non-empty text is now the caption, an
   * empty one falls back to the auto label. Returns the text to store. Self-destructing media never gets a caption.
   */
  onMessageEdited(messageId: string, text: string): string {
    const rows = this.itemsOfMessage(messageId);
    if (!rows.length) return text;
    const caption = rows[0].expiresAt || rows[0].viewOnce ? "" : text.trim();
    const label = !caption;
    const list = rows.map((r) => this.toAttachment(r));
    const out = caption || (rows.length > 1 ? albumLabel(list) : mediaLabel({ kind: rows[0].kind, name: rows[0].name ?? undefined, gif: rows[0].gif }));
    for (const r of rows) {
      if (r.label === label) continue;
      r.label = label;
      void this.repo!.update(r.id, { label }).catch(() => {});
    }
    this.publishMessage(rows[0].conversationId, messageId, out);
    return out;
  }

  /**
   * Forwarding (Telegram-style): a fresh, unsent copy of a sent attachment owned by the forwarder, so the normal
   * send() path (ownership, albums, groups, pushes) handles it. Files are hard-linked (no extra disk, copy fallback);
   * deleting either message only unlinks its own copy. View-once and timer media are never forwardable.
   */
  async cloneForForward(userId: string, mediaId: string): Promise<string> {
    const r = ID_RE.test(mediaId) ? this.rows.get(mediaId) : undefined;
    if (!r || !r.messageId || !this.canView(userId, r)) throw new MediaError("That attachment isn't available any more", 404);
    if (r.viewOnce || r.expiresAt || r.ttlSeconds) throw new MediaError("Self-destructing media can't be forwarded", 400);
    if (r.status !== "ready") throw new MediaError("That video is still processing. Try again in a moment.", 409);
    const id = randomUUID().replace(/-/g, "");
    const from = this.dirOf(r.id);
    const to = this.dirOf(id);
    const linkTree = (a: string, b: string) => {
      fs.mkdirSync(b, { recursive: true });
      for (const e of fs.readdirSync(a, { withFileTypes: true })) {
        const pa = path.join(a, e.name);
        const pb = path.join(b, e.name);
        if (e.isDirectory()) linkTree(pa, pb);
        else if (e.isFile()) {
          try {
            fs.linkSync(pa, pb);
          } catch {
            fs.copyFileSync(pa, pb);
          }
        }
      }
    };
    try {
      linkTree(from, to);
      const now = Date.now();
      const row: MediaRow = {
        ...r,
        files: JSON.parse(JSON.stringify(r.files)) as MediaRow["files"],
        id,
        ownerId: userId,
        conversationId: null,
        messageId: null,
        ttlSeconds: null,
        viewOnce: false,
        expiresAt: null,
        openedAt: null,
        playedAt: null,
        createdAt: now,
        sentAt: null,
        position: 0,
        label: true,
        rev: 1,
      };
      this.rows.set(id, row);
      await this.repo!.insert(row);
      return id;
    } catch (e) {
      this.rows.delete(id);
      fs.rmSync(to, { recursive: true, force: true });
      throw e;
    }
  }

  /** ids of the attachments on a message, album order (forwarding) */
  mediaIdsOf(messageId: string) {
    return this.itemsOfMessage(messageId).map((r) => r.id);
  }

  /** test/debug */
  row(id: string) {
    return this.rows.get(id);
  }
}

export const media = new MediaService();
