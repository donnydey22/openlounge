// "Original" downloads (Telegram-style): the sender's own bytes, pixels untouched, minus anything that identifies
// where/what it was shot with. Photos: JPEG / PNG only, done losslessly by dropping metadata segments/chunks (never a
// re-encode). JPEG orientation survives as a minimal EXIF holding only the Orientation tag. Videos: a stream copy
// (no re-encode) with global metadata, chapters and data streams (GPS tracks) dropped. Anything we can't strip safely
// (HEIC, WebP, odd files) gets no original — the processed "full" stays the download, exactly as today.
import fs from "node:fs";
import path from "node:path";

/** APP0 (JFIF), APP2 (ICC profile) and APP14 (Adobe colour transform) matter for decoding; every other APPn + COM goes. */
const JPEG_KEEP_APP = new Set([0xe0, 0xe2, 0xee]);

function minimalExif(orientation: number) {
  // "Exif\0\0" + big-endian TIFF header + IFD0 with a single SHORT entry (0x0112 Orientation) + next-IFD 0
  const tiff = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation & 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xe1]), len, body]);
}

/** Lossless JPEG metadata strip. Returns null on anything unexpected (then no original is kept). */
export function stripJpeg(buf: Buffer, orientation = 1): Buffer | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const out: Buffer[] = [buf.subarray(0, 2)];
  if (orientation > 1 && orientation <= 8) out.push(minimalExif(orientation));
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { out.push(buf.subarray(i, i + 2)); i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    if (m === 0xda) {
      // start of scan: image data up to the primary image's EOI. Anything appended after it (iPhone MPF gain maps /
      // depth images, each with its own EXIF + GPS) is dropped. FF D9 can't occur inside entropy-coded data.
      const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), i + 2 + len);
      if (eoi < 0) return null;
      out.push(buf.subarray(i, eoi + 2));
      return Buffer.concat(out);
    }
    const isApp = m >= 0xe0 && m <= 0xef;
    // APP2 is kept only for ICC profiles (an APP2 "MPF" index would point at the dropped appended images)
    const mpf = m === 0xe2 && buf.toString("latin1", i + 4, i + 8) === "MPF\0";
    if (!(isApp && !JPEG_KEEP_APP.has(m)) && m !== 0xfe && !mpf) out.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

/** PNG chunks that carry pixels/colour; text, EXIF and timestamps are dropped. APNG frames kept. */
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "pHYs", "acTL", "fcTL", "fdAT", "bKGD", "cICP"]);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function stripPng(buf: Buffer): Buffer | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const out: Buffer[] = [PNG_SIG];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("latin1", i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) return null;
    if (PNG_KEEP.has(type)) out.push(buf.subarray(i, end));
    i = end;
    if (type === "IEND") return Buffer.concat(out);
  }
  return null;
}

/**
 * Keep a stripped original photo next to the processed one when it is worth it (bigger than what we serve inline).
 * Writes `source.<ext>`; returns its file entry or null.
 */
export function keepOriginalPhoto(src: string, dir: string, mime: string, o: { orientation?: number; srcW: number; srcH: number; fullW: number; fullH: number; fullBytes: number }) {
  if (mime !== "image/jpeg" && mime !== "image/png") return null;
  const buf = fs.readFileSync(src);
  const stripped = mime === "image/jpeg" ? stripJpeg(buf, o.orientation ?? 1) : stripPng(buf);
  if (!stripped) return null;
  // worth a second copy only when the inline version lost something: fewer pixels, or recompression threw away a
  // meaningful amount of detail (≥15% and ≥64 KB). Small photos keep exactly today's single file.
  const larger = Math.max(o.srcW, o.srcH) > Math.max(o.fullW, o.fullH) || (stripped.length > o.fullBytes * 1.15 && stripped.length - o.fullBytes >= 64 * 1024);
  if (!larger) return null;
  const file = mime === "image/jpeg" ? "source.jpg" : "source.png";
  fs.writeFileSync(path.join(dir, file), stripped);
  return { file, mime, size: stripped.length };
}
