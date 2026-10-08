// Server-side MIME detection from magic bytes. The client's declared type is never trusted: what we store and serve
// is decided here (and confirmed by sharp / ffprobe decoding the file for photos, videos and voice).

export interface Sniffed {
  mime: string;
  /** broad family for validation */
  family: "image" | "video" | "audio" | "pdf" | "zip" | "text" | "other";
  ext: string;
}

const ascii = (b: Buffer, start: number, end: number) => b.subarray(start, end).toString("latin1");

export function sniff(head: Buffer, name = ""): Sniffed {
  const b = head;
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", family: "image", ext: "jpg" };
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return { mime: "image/png", family: "image", ext: "png" };
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return { mime: "image/gif", family: "image", ext: "gif" };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return { mime: "image/webp", family: "image", ext: "webp" };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WAVE") return { mime: "audio/wav", family: "audio", ext: "wav" };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "AVI ") return { mime: "video/x-msvideo", family: "video", ext: "avi" };
  if (ascii(b, 0, 2) === "BM" && b.length > 14) return { mime: "image/bmp", family: "image", ext: "bmp" };
  if ((ascii(b, 0, 4) === "II*\0" || ascii(b, 0, 4) === "MM\0*")) return { mime: "image/tiff", family: "image", ext: "tif" };
  if (ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    const brands = ascii(b, 8, Math.min(b.length, 64));
    if (/^(heic|heix|hevc|hevx|heim|heis)$/.test(brand) || (/^(mif1|msf1)$/.test(brand) && /hei[cx]|hevc/.test(brands)))
      return { mime: "image/heic", family: "image", ext: "heic" };
    if (brand === "avif" || brand === "avis" || (/^(mif1|msf1)$/.test(brand) && /avif/.test(brands))) return { mime: "image/avif", family: "image", ext: "avif" };
    if (/^(mif1|msf1)$/.test(brand)) return { mime: "image/heif", family: "image", ext: "heif" };
    if (brand === "M4A " || brand === "M4B ") return { mime: "audio/mp4", family: "audio", ext: "m4a" };
    if (brand === "qt  ") return { mime: "video/quicktime", family: "video", ext: "mov" };
    if (brand.startsWith("3g")) return { mime: "video/3gpp", family: "video", ext: "3gp" };
    // isom / mp41 / mp42 / avc1 / iso5 / dash / M4V … — audio-only mp4 (Safari's MediaRecorder) is told apart by ffprobe
    return { mime: "video/mp4", family: "video", ext: "mp4" };
  }
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) {
    const doc = b.subarray(0, 64).toString("latin1");
    return doc.includes("webm") ? { mime: "video/webm", family: "video", ext: "webm" } : { mime: "video/x-matroska", family: "video", ext: "mkv" };
  }
  if (ascii(b, 0, 4) === "OggS") return { mime: "audio/ogg", family: "audio", ext: "ogg" };
  if (ascii(b, 0, 4) === "fLaC") return { mime: "audio/flac", family: "audio", ext: "flac" };
  if (ascii(b, 0, 3) === "ID3" || (b.length > 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)) {
    // MPEG audio frame sync (0xFFE/0xFFF) — but not JPEG (handled above) and not AAC ADTS (0xFFF1/0xFFF9)
    if (b[0] === 0xff && (b[1] === 0xf1 || b[1] === 0xf9)) return { mime: "audio/aac", family: "audio", ext: "aac" };
    return { mime: "audio/mpeg", family: "audio", ext: "mp3" };
  }
  if (b.length > 2 && b[0] === 0xff && (b[1] === 0xf1 || b[1] === 0xf9)) return { mime: "audio/aac", family: "audio", ext: "aac" };
  if (ascii(b, 0, 5) === "%PDF-") return { mime: "application/pdf", family: "pdf", ext: "pdf" };
  if (ascii(b, 0, 4) === "PK\x03\x04" || ascii(b, 0, 4) === "PK\x05\x06") {
    const map: Record<string, string> = {
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      odt: "application/vnd.oasis.opendocument.text",
      ods: "application/vnd.oasis.opendocument.spreadsheet",
      epub: "application/epub+zip",
      apk: "application/vnd.android.package-archive",
      jar: "application/java-archive",
    };
    return { mime: map[ext] ?? "application/zip", family: "zip", ext: map[ext] ? ext : "zip" };
  }
  if (ascii(b, 0, 6) === "7z\xbc\xaf\x27\x1c") return { mime: "application/x-7z-compressed", family: "other", ext: "7z" };
  if (ascii(b, 0, 4) === "Rar!") return { mime: "application/vnd.rar", family: "other", ext: "rar" };
  if (b.length > 2 && b[0] === 0x1f && b[1] === 0x8b) return { mime: "application/gzip", family: "other", ext: "gz" };
  if (b.length >= 8 && b.readUInt32BE(0) === 0xd0cf11e0 && b.readUInt32BE(4) === 0xa1b11ae1) {
    const legacy: Record<string, string> = { doc: "application/msword", xls: "application/vnd.ms-excel", ppt: "application/vnd.ms-powerpoint" };
    return { mime: legacy[ext] ?? "application/x-ole-storage", family: "other", ext: legacy[ext] ? ext : "bin" };
  }
  if (ascii(b, 0, 5) === "{\\rtf") return { mime: "application/rtf", family: "other", ext: "rtf" };
  if (looksLikeText(b)) {
    const textMimes: Record<string, string> = { csv: "text/csv", md: "text/markdown", json: "application/json", txt: "text/plain", tsv: "text/tab-separated-values" };
    // never serve markup as markup (svg/html/xml are stored as plain text downloads)
    return { mime: textMimes[ext] ?? "text/plain", family: "text", ext: textMimes[ext] ? ext : "txt" };
  }
  return { mime: "application/octet-stream", family: "other", ext: "bin" };
}

function looksLikeText(b: Buffer) {
  if (!b.length) return false;
  const n = Math.min(b.length, 4096);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32)) bad++;
  }
  if (bad / n > 0.02) return false;
  // must decode as UTF-8 (allow a cut multibyte sequence at the very end)
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, n - 4 > 0 ? n - 4 : n));
    return true;
  } catch {
    return false;
  }
}

/** Mimes a browser may render inline from our origin (everything else is served as an attachment download). */
export const INLINE_SAFE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif", "video/mp4", "audio/mp4", "audio/mpeg", "application/pdf", "text/plain"]);

/** safe download file name (no path, no control chars, ≤ 120 chars, keeps the extension) */
export function safeName(name: unknown, fallback = "file") {
  let s = String(name ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f/\\]+/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^\.+/, "");
  if (!s) return fallback;
  if (s.length > 120) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : "";
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s;
}
