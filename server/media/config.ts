// Media pipeline configuration. Files live on local disk at UPLOAD_DIR (Railway volume: /data/uploads).
import path from "node:path";
import { DATA_DIR } from "../persistence";

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

export const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(DATA_DIR, "uploads"));
/** in-progress resumable uploads (raw bytes + a JSON sidecar), cleaned after UPLOAD_STALE_MS */
export const TMP_DIR = path.join(UPLOAD_DIR, "tmp");
/** processed media: UPLOAD_DIR/m/<2-char shard>/<mediaId>/<variant files> */
export const MEDIA_DIR = path.join(UPLOAD_DIR, "m");

export const CHUNK_MAX_BYTES = num(process.env.MEDIA_CHUNK_MAX_BYTES, 8 * 1024 * 1024);
export const CHUNK_DEFAULT_BYTES = num(process.env.MEDIA_CHUNK_BYTES, 1024 * 1024);
export const UPLOAD_STALE_MS = num(process.env.MEDIA_UPLOAD_STALE_MS, 24 * 3600_000);
/** media uploaded but never sent is removed after this long */
export const UNSENT_TTL_MS = num(process.env.MEDIA_UNSENT_TTL_MS, 6 * 3600_000);
/** open (not yet completed) uploads per user */
export const MAX_OPEN_UPLOADS = num(process.env.MEDIA_MAX_OPEN_UPLOADS, 12);
/** uploads started per user per 10 minutes */
export const UPLOADS_PER_10MIN = num(process.env.MEDIA_UPLOADS_PER_10MIN, 120);
/** keep at least this much free space on the volume (avatars, db.json fallback, temp files) */
export const DISK_RESERVE_BYTES = num(process.env.MEDIA_DISK_RESERVE_BYTES, 64 * 1024 * 1024);
/** signed URLs: valid for this long; rounded to a window so repeated signs give the same URL (browser cache hits) */
export const URL_TTL_S = num(process.env.MEDIA_URL_TTL_S, 600);
export const URL_WINDOW_S = num(process.env.MEDIA_URL_WINDOW_S, 300);
/** sweeper tick (expiring media is also timed precisely with setTimeout) */
export const SWEEP_MS = num(process.env.MEDIA_SWEEP_MS, 15_000);
/** ffmpeg: one heavy job at a time, single thread (small container) */
export const FFMPEG_THREADS = num(process.env.MEDIA_FFMPEG_THREADS, 1);
export const VIDEO_MAX_EDGE = num(process.env.MEDIA_VIDEO_MAX_EDGE, 1280);
export const PHOTO_MAX_EDGE = num(process.env.MEDIA_PHOTO_MAX_EDGE, 2560);
export const THUMB_MAX_EDGE = num(process.env.MEDIA_THUMB_MAX_EDGE, 640);
export const VOICE_MAX_MS = num(process.env.MEDIA_VOICE_MAX_MS, 15 * 60_000);
export const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
export const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

// ---------- adaptive video (HLS ladder) + self-hosted media cache (see /workspace/media/CACHE_CONTRACT.md) ----------
/** HLS ladder rungs (short edge, px). Only rungs <= the source's short edge are made; 240 is always made first. */
export const HLS_RUNGS = (process.env.MEDIA_HLS_RUNGS || "240,360,480,720").split(",").map(Number).filter((n) => n >= 144 && n <= 720).sort((a, b) => a - b);
/** videos longer than this get the MP4 only (protects CPU; uploads are capped at 200 MB anyway) */
export const HLS_MAX_MS = num(process.env.MEDIA_HLS_MAX_MS, 30 * 60_000);
export const HLS_ENABLED = process.env.MEDIA_HLS !== "0";
/** background ladder jobs run at this nice level so live rooms/API keep the CPU */
export const HLS_NICE = num(process.env.MEDIA_HLS_NICE, 10);
/** "" → same-origin (openlounge.app); set → the self-hosted cache service's public URL */
export const MEDIA_CDN_BASE = (process.env.MEDIA_CDN_BASE || "").replace(/\/+$/, "");
/** origin-only listener for the cache service over Railway private networking (0 disables) */
export const MEDIA_INTERNAL_PORT = num(process.env.MEDIA_INTERNAL_PORT, 8081);
/** HLS/video directory links stay valid for the clip + this much */
export const HLS_URL_EXTRA_S = num(process.env.MEDIA_HLS_URL_EXTRA_S, 15 * 60);
