// Shared (client + server) media types: photos, videos, documents and voice notes in chats.
// The attachment rides on a DirectMessage as `media`. URLs are never stored on the message: clients ask for short-lived
// signed URLs (POST /api/media/sign) for what is on screen, so a block / expiry / delete takes effect immediately.

export const MEDIA_KINDS = ["photo", "video", "document", "voice"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Upload size caps (bytes), enforced on the server at upload start and on every chunk. */
export const MEDIA_LIMITS: Record<MediaKind, number> = {
  photo: 25 * 1024 * 1024,
  document: 100 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  voice: 25 * 1024 * 1024,
};

/** Self-destruct timers offered in the attach sheet (seconds). Custom is any value up to MAX_TTL_SECONDS. */
export const TTL_PRESETS = [
  { label: "Off", seconds: 0 },
  { label: "1 minute", seconds: 60 },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86_400 },
  { label: "1 week", seconds: 604_800 },
] as const;
export const MAX_TTL_SECONDS = 30 * 86_400;
export const MIN_TTL_SECONDS = 5;
/** View-once media: deleted when the recipient closes it, or this long after opening at the latest. */
export const VIEW_ONCE_GRACE_MS = 60_000;

export type MediaStatus = "processing" | "ready" | "failed";
export type MediaGoneReason = "expired" | "viewed" | "deleted";

/** Signed-URL variants a client can ask for. */
export type MediaVariant = "full" | "thumb" | "poster" | "original" | "hls" | "hlsLow" | "thumbS" | "thumbAvif" | "thumbSAvif";

export interface MediaAttachment {
  id: string;
  kind: MediaKind;
  /** mime of the main (served) file, e.g. image/jpeg, video/mp4, audio/mp4, application/pdf */
  mime: string;
  size: number;
  /** original file name (documents; also kept for photos/videos for "Save as") */
  name?: string;
  w?: number;
  h?: number;
  /** video / voice duration */
  durMs?: number;
  /** voice: 64 peaks 0..255, base64 */
  wave?: string;
  /** tiny blurred preview (data: URL, < 1 KB) shown before the thumbnail loads — no layout shift */
  ph?: string;
  /** animated GIF converted to a silent looping mp4 (Telegram style) */
  gif?: boolean;
  status: MediaStatus;
  /** which variants exist (thumb for photos/videos/image documents, poster for videos) */
  thumb?: boolean;
  poster?: boolean;
  /** adaptive video: HLS rungs available so far (short edge px, e.g. [240, 360]); absent → MP4 only */
  hls?: number[];
  /** photos: responsive thumbnails exist (thumbS 320 WebP, thumbAvif 640 / thumbSAvif 320 AVIF) */
  srcset?: boolean;
  /** the message text is the auto label ("📷 Photo"), not a caption the sender typed */
  label?: boolean;
  /** self-destruct */
  ttl?: number;
  viewOnce?: boolean;
  expiresAt?: number | null;
  /** view once: when the recipient opened it */
  openedAt?: number | null;
  /** voice: when the recipient first played it (the unplayed dot) */
  playedAt?: number | null;
  /** set when the file is gone: placeholder "Photo expired" keeps reply chains intact */
  gone?: { reason: MediaGoneReason; at: number } | null;
}

/** "media:update" WebSocket event: the attachment of `messageId` changed (processed, played, opened, expired, deleted). */
export interface MediaUpdateEvent {
  messageId: string;
  media: MediaAttachment;
  /** albums: the full ordered list after the change (an item deleted / expired / finished processing) */
  attachments?: MediaAttachment[];
  /** new message text when it changed (a self-destructed caption is replaced by the label) */
  text?: string;
}

export const MEDIA_LABEL: Record<MediaKind, string> = {
  photo: "📷 Photo",
  video: "🎥 Video",
  document: "📄 File",
  voice: "🎤 Voice message",
};

export function mediaLabel(m: Pick<MediaAttachment, "kind" | "name" | "gif">) {
  if (m.kind === "document" && m.name) return `📄 ${m.name}`.slice(0, 200);
  if (m.gif) return "🎞️ GIF";
  return MEDIA_LABEL[m.kind];
}

export const ALBUM_MAX = 10;

/** "🖼️ Album · 3 photos, 1 video" */
export function albumLabel(items: Pick<MediaAttachment, "kind" | "gif">[]) {
  const photos = items.filter((x) => x.kind === "photo").length;
  const videos = items.length - photos;
  const parts = [photos ? `${photos} photo${photos === 1 ? "" : "s"}` : "", videos ? `${videos} video${videos === 1 ? "" : "s"}` : ""].filter(Boolean);
  return `🖼️ Album · ${parts.join(", ")}`;
}

/** The ordered items of a media message (album or single); [] for text messages. */
export function itemsOf(m: { media?: MediaAttachment; attachments?: MediaAttachment[] }): MediaAttachment[] {
  return m.attachments?.length ? m.attachments : m.media ? [m.media] : [];
}

export function goneLabel(m: Pick<MediaAttachment, "kind" | "gone" | "viewOnce" | "gif">) {
  const noun = m.kind === "photo" ? "Photo" : m.kind === "video" ? (m.gif ? "GIF" : "Video") : m.kind === "voice" ? "Voice message" : "File";
  if (m.gone?.reason === "deleted") return `${noun} deleted`;
  if (m.gone?.reason === "viewed" || m.viewOnce) return `${noun} viewed`;
  return `${noun} expired`;
}

/** Is the attachment unavailable at `now` (server clock)? Clients hide it locally at expiresAt even before the event. */
export function mediaGone(m: MediaAttachment | undefined | null, now: number) {
  if (!m) return false;
  return !!m.gone || (!!m.expiresAt && m.expiresAt <= now);
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function formatDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "Expires in 59m" / "in 3h" / "in 2d" */
export function formatRemaining(ms: number) {
  if (ms <= 0) return "now";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 && h < 10 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 && d < 7 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Short badge text on the bubble: "59s", "59m", "23h", "6d" */
export function formatBadge(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.ceil(s / 60)}m`;
  if (s < 86_400) return `${Math.ceil(s / 3600)}h`;
  return `${Math.ceil(s / 86_400)}d`;
}

/** document icon family from a file name / mime */
export function docFamily(name = "", mime = ""): "pdf" | "image" | "video" | "audio" | "archive" | "sheet" | "slides" | "doc" | "code" | "apk" | "file" {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (["zip", "rar", "7z", "gz", "tgz", "tar", "bz2", "xz"].includes(ext)) return "archive";
  if (["xls", "xlsx", "csv", "ods", "numbers", "tsv"].includes(ext)) return "sheet";
  if (["ppt", "pptx", "key", "odp"].includes(ext)) return "slides";
  if (["doc", "docx", "odt", "rtf", "txt", "md", "pages"].includes(ext)) return "doc";
  if (["js", "ts", "json", "html", "css", "py", "java", "c", "cpp", "go", "rs", "sh", "xml", "yml", "yaml"].includes(ext)) return "code";
  if (ext === "apk" || ext === "ipa") return "apk";
  return "file";
}
