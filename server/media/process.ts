// Media processing: sharp for images (EXIF/GPS stripped, auto-rotated, resized, blurred placeholder) and ffmpeg for
// video (faststart remux or H.264 transcode, poster frame), voice (→ AAC/m4a, waveform) and animated GIF (→ silent mp4).
// Heavy ffmpeg work runs one job at a time so a small container never runs out of memory or CPU for the live rooms.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { FFMPEG, FFMPEG_THREADS, FFPROBE, PHOTO_MAX_EDGE, THUMB_MAX_EDGE, VIDEO_MAX_EDGE, VOICE_MAX_MS } from "./config";

sharp.cache(false);
sharp.concurrency(1);

export class MediaError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

// ---------- a tiny job queue (ffmpeg: 1 at a time) ----------
export class Queue {
  private running = 0;
  private waiting: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
  get depth() {
    return this.running + this.waiting.length;
  }
}
export const ffQueue = new Queue(1);
const imgQueue = new Queue(2);

export function run(cmd: string, args: string[], opts: { timeoutMs?: number; stdout?: boolean } = {}): Promise<{ code: number; out: Buffer; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    let outLen = 0;
    p.stdout.on("data", (d: Buffer) => {
      if (!opts.stdout) return;
      outLen += d.length;
      if (outLen < 64 * 1024 * 1024) out.push(d);
    });
    p.stderr.on("data", (d: Buffer) => {
      err = (err + d.toString()).slice(-4000);
    });
    const t = setTimeout(() => p.kill("SIGKILL"), opts.timeoutMs ?? 10 * 60_000);
    p.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, out: Buffer.concat(out), err });
    });
  });
}

let ffAvailable: boolean | null = null;
export async function ffmpegAvailable() {
  if (ffAvailable === null) ffAvailable = await run(FFMPEG, ["-version"], { timeoutMs: 5000 }).then((r) => r.code === 0).catch(() => false);
  return ffAvailable;
}

// ---------- probing ----------
export interface Probe {
  durationMs: number;
  format: string;
  video: { codec: string; width: number; height: number; rotation: number; pixFmt: string } | null;
  audio: { codec: string } | null;
}

export async function probe(file: string): Promise<Probe> {
  const r = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { stdout: true, timeoutMs: 30_000 });
  if (r.code !== 0) throw new MediaError("This file couldn't be read as audio or video");
  const j = JSON.parse(r.out.toString() || "{}") as {
    format?: { duration?: string; format_name?: string };
    streams?: { codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string; duration?: string; tags?: Record<string, string>; side_data_list?: { rotation?: number }[]; disposition?: { attached_pic?: number } }[];
  };
  const streams = j.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");
  const dur = Number(j.format?.duration ?? v?.duration ?? 0);
  let rotation = 0;
  if (v) rotation = Number(v.tags?.rotate ?? v.side_data_list?.find((x) => x.rotation !== undefined)?.rotation ?? 0) || 0;
  return {
    durationMs: Number.isFinite(dur) ? Math.round(dur * 1000) : 0,
    format: j.format?.format_name ?? "",
    video: v ? { codec: v.codec_name, width: v.width ?? 0, height: v.height ?? 0, rotation: ((rotation % 360) + 360) % 360, pixFmt: v.pix_fmt ?? "" } : null,
    audio: a ? { codec: a.codec_name } : null,
  };
}

// ---------- images ----------
export interface ImageOut {
  width: number;
  height: number;
  mime: string;
  ext: string;
  placeholder: string;
}

/** tiny blurred preview as a data URL (~300-700 bytes) */
export async function placeholderFrom(input: Buffer | string): Promise<string> {
  const buf = await sharp(input, { failOn: "none" }).rotate().resize(20, 20, { fit: "inside" }).blur(1.2).webp({ quality: 40 }).toBuffer();
  return `data:image/webp;base64,${buf.toString("base64")}`;
}

async function heicToJpeg(src: string, dst: string) {
  // sharp's prebuilt libvips has no HEVC decoder; libheif's heif-convert (Docker image) does
  for (const cmd of ["heif-convert", "heif-dec"]) {
    const r = await run(cmd, ["-q", "92", src, dst], { timeoutMs: 60_000 }).catch(() => null);
    if (r?.code === 0 && fs.existsSync(dst)) return true;
  }
  const r = await run(FFMPEG, ["-y", "-v", "error", "-i", src, "-frames:v", "1", dst], { timeoutMs: 60_000 }).catch(() => null);
  return r?.code === 0 && fs.existsSync(dst);
}

/**
 * Photo: auto-rotate, strip all metadata (EXIF/GPS/XMP — sharp drops it unless asked to keep it), cap the long edge,
 * re-encode (JPEG, or WebP when there's transparency), plus a 640px WebP thumbnail and a blurred placeholder.
 */
export async function processImage(src: string, outDir: string, sniffedMime: string): Promise<ImageOut & { thumb: boolean }> {
  return imgQueue.run(async () => {
    let input = src;
    if (sniffedMime === "image/heic" || sniffedMime === "image/heif") {
      const conv = path.join(outDir, "heic.jpg");
      if (!(await heicToJpeg(src, conv))) throw new MediaError("This HEIC photo couldn't be converted. Try sending it as a JPEG.");
      input = conv;
    }
    const img = sharp(input, { failOn: "none", limitInputPixels: 120_000_000 });
    const meta = await img.metadata().catch(() => null);
    if (!meta || !meta.width || !meta.height) throw new MediaError("This image couldn't be read");
    const alpha = !!meta.hasAlpha && sniffedMime !== "image/jpeg";
    const base = sharp(input, { failOn: "none", limitInputPixels: 120_000_000 }).rotate().resize(PHOTO_MAX_EDGE, PHOTO_MAX_EDGE, { fit: "inside", withoutEnlargement: true });
    const full = alpha ? base.webp({ quality: 86, effort: 4 }) : base.jpeg({ quality: 84, progressive: true, mozjpeg: true });
    const ext = alpha ? "webp" : "jpg";
    const info = await full.toFile(path.join(outDir, `full.${ext}`));
    await sharp(path.join(outDir, `full.${ext}`)).resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: "inside", withoutEnlargement: true }).webp({ quality: 72 }).toFile(path.join(outDir, "thumb.webp"));
    const placeholder = await placeholderFrom(path.join(outDir, "thumb.webp"));
    if (input !== src) fs.rmSync(input, { force: true });
    return { width: info.width, height: info.height, mime: alpha ? "image/webp" : "image/jpeg", ext, placeholder, thumb: true };
  });
}

/** Is this GIF animated (more than one frame)? */
export async function gifFrames(src: string) {
  const m = await sharp(src, { failOn: "none", animated: true }).metadata().catch(() => null);
  return m?.pages ?? 1;
}

// ---------- video ----------
const H264_SAFE = (p: Probe) =>
  !!p.video && p.video.codec === "h264" && /^(yuv420p|yuvj420p)$/.test(p.video.pixFmt) && (!p.audio || p.audio.codec === "aac" || p.audio.codec === "mp3") && /mp4|mov/.test(p.format);

export interface VideoOut {
  width: number;
  height: number;
  durationMs: number;
  placeholder: string;
  /** a full transcode is still needed (runs in the background); the remuxed/original file is served meanwhile */
  needsTranscode: boolean;
  /** an mp4 playable everywhere already exists */
  playable: boolean;
}

/** displayed size after rotation, capped to VIDEO_MAX_EDGE (even numbers) */
function outSize(p: Probe) {
  let w = p.video!.width;
  let h = p.video!.height;
  if (p.video!.rotation === 90 || p.video!.rotation === 270) [w, h] = [h, w];
  const k = Math.min(1, VIDEO_MAX_EDGE / Math.max(w, h));
  return { w: Math.max(2, Math.round((w * k) / 2) * 2), h: Math.max(2, Math.round((h * k) / 2) * 2) };
}

/** Poster frame (WebP 640px) + placeholder from a video. */
export async function poster(src: string, outDir: string, durationMs: number) {
  const at = durationMs > 2000 ? "0.5" : "0";
  const jpg = path.join(outDir, "poster-src.jpg");
  const r = await run(FFMPEG, ["-y", "-v", "error", "-ss", at, "-i", src, "-frames:v", "1", "-q:v", "3", jpg], { timeoutMs: 60_000 });
  if (r.code !== 0 || !fs.existsSync(jpg)) {
    const r2 = await run(FFMPEG, ["-y", "-v", "error", "-i", src, "-frames:v", "1", "-q:v", "3", jpg], { timeoutMs: 60_000 });
    if (r2.code !== 0 || !fs.existsSync(jpg)) throw new MediaError("This video couldn't be read");
  }
  await sharp(jpg).resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: "inside", withoutEnlargement: true }).webp({ quality: 72 }).toFile(path.join(outDir, "poster.webp"));
  const placeholder = await placeholderFrom(path.join(outDir, "poster.webp"));
  fs.rmSync(jpg, { force: true });
  return placeholder;
}

/**
 * Fast path (inline, seconds): H.264/AAC → copy streams into a faststart mp4 with every metadata atom dropped
 * (location, device, creation time). Anything else (HEVC, VP8/9, AV1, 10-bit, odd containers) is flagged for a
 * background transcode to H.264 so it plays on every browser and WebView back to iOS 15 / Android 7.
 */
export async function processVideo(src: string, outDir: string, opts: { gif?: boolean } = {}): Promise<VideoOut> {
  const p = await probe(src);
  if (!p.video || !p.video.width) throw new MediaError("This file has no video");
  const { w, h } = outSize(p);
  const placeholder = await poster(src, outDir, p.durationMs);
  if (!opts.gif && H264_SAFE(p) && Math.max(p.video.width, p.video.height) <= 1920) {
    const r = await ffQueue.run(() =>
      run(FFMPEG, ["-y", "-v", "error", "-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", "-f", "mp4", path.join(outDir, "full.mp4")], { timeoutMs: 5 * 60_000 }),
    );
    if (r.code === 0) return { width: w, height: h, durationMs: p.durationMs, placeholder, needsTranscode: false, playable: true };
  }
  return { width: w, height: h, durationMs: p.durationMs, placeholder, needsTranscode: true, playable: false };
}

/** Background H.264 transcode (also GIF → silent looping mp4). */
export async function transcodeVideo(src: string, outDir: string, opts: { gif?: boolean } = {}) {
  const p = await probe(src);
  const { w, h } = outSize(p);
  const tmp = path.join(outDir, "full.tmp.mp4");
  const args = [
    "-y", "-v", "error", "-i", src,
    "-map", "0:v:0", ...(opts.gif ? ["-an"] : ["-map", "0:a:0?"]),
    "-vf", `scale=${w}:${h}:flags=bicubic,format=yuv420p`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", opts.gif ? "28" : "24", "-profile:v", "high", "-level", "4.0",
    ...(opts.gif ? [] : ["-c:a", "aac", "-b:a", "96k", "-ac", "2"]),
    "-threads", String(FFMPEG_THREADS), "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", "-f", "mp4", tmp,
  ];
  const r = await ffQueue.run(() => run(FFMPEG, args, { timeoutMs: 30 * 60_000 }));
  if (r.code !== 0) throw new MediaError(`transcode failed: ${r.err.slice(-300)}`, 500);
  fs.renameSync(tmp, path.join(outDir, "full.mp4"));
  return { width: w, height: h, durationMs: p.durationMs };
}

// ---------- voice ----------
export interface VoiceOut {
  durationMs: number;
  waveform: string;
}

/** 64 peaks (0..255) from mono 8 kHz PCM, gently normalised so quiet notes still show a shape */
export function peaks(pcm: Buffer, bars = 64): Buffer {
  const samples = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(bars);
  if (!samples) return out;
  const per = samples / bars;
  const vals: number[] = [];
  for (let b = 0; b < bars; b++) {
    const s0 = Math.floor(b * per);
    const s1 = Math.max(s0 + 1, Math.floor((b + 1) * per));
    let sum = 0;
    let n = 0;
    for (let i = s0; i < s1 && i < samples; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      sum += v * v;
      n++;
    }
    vals.push(Math.sqrt(sum / Math.max(1, n)));
  }
  const max = Math.max(...vals, 1e-4);
  vals.forEach((v, i) => (out[i] = Math.round(Math.min(1, Math.pow(v / max, 0.8)) * 255)));
  return out;
}

/**
 * Voice note → AAC-LC in m4a (48 kbps mono, faststart): the one format every target plays (Chrome/Firefox/Edge,
 * Safari and WKWebView back to iOS 15, Android 7 WebView). Input is whatever the recorder produced: webm/opus
 * (Chrome, Firefox, Android), mp4/aac (Safari), ogg/opus, or an uploaded audio file.
 */
export async function processVoice(src: string, outDir: string): Promise<VoiceOut> {
  const p = await probe(src);
  if (!p.audio) throw new MediaError("This recording has no audio");
  const out = path.join(outDir, "full.m4a");
  const r = await ffQueue.run(() =>
    run(FFMPEG, ["-y", "-v", "error", "-i", src, "-map", "0:a:0", "-vn", "-t", String(VOICE_MAX_MS / 1000), "-c:a", "aac", "-b:a", "48k", "-ac", "1", "-ar", "48000", "-threads", String(FFMPEG_THREADS), "-map_metadata", "-1", "-movflags", "+faststart", "-f", "mp4", out], { timeoutMs: 5 * 60_000 }),
  );
  if (r.code !== 0) throw new MediaError("This recording couldn't be processed");
  const pcm = await run(FFMPEG, ["-v", "error", "-i", out, "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { stdout: true, timeoutMs: 60_000 });
  const durationMs = Math.round((pcm.out.length / 2 / 8000) * 1000) || (await probe(out)).durationMs;
  return { durationMs, waveform: peaks(pcm.out).toString("base64") };
}
