// Adaptive video: VOD HLS ladder made once at upload time (never on the fly).
//   • H.264 + AAC for universal hardware decode: 240p/360p Main@3.1, 480p/720p High@3.1, max 720p30
//   • closed GOPs, IDR every 2 s forced on the same timestamps in every rendition (aligned switch points)
//   • fMP4/CMAF segments (~4 s; the first one ~2 s for a fast start), per-rendition VOD playlists
//   • master playlists with BANDWIDTH (measured peak) / AVERAGE-BANDWIDTH / RESOLUTION / CODECS / FRAME-RATE:
//     master.m3u8 lists 360p first (Safari/native HLS starts on the first entry), master-low.m3u8 lists 240p first
//     (slow / cellular / data saver). hls.js picks its own start level either way.
// 240p is encoded alone first so the video is playable early; the remaining rungs follow in ONE ffmpeg pass with
// multiple outputs and are then added to the masters. All of it runs on a dedicated queue (concurrency 1), at a
// lower CPU priority, single-threaded, preset veryfast, so the live rooms and the API never starve.
import fs from "node:fs";
import path from "node:path";
import { FFMPEG, FFMPEG_THREADS, HLS_NICE, HLS_RUNGS, VIDEO_MAX_EDGE } from "./config";
import { Queue, run, probe, MediaError, type Probe } from "./process";

export const hlsQueue = new Queue(1);

export interface RungInfo {
  /** short edge (the rung name: 240, 360, …) */
  r: number;
  width: number;
  height: number;
  bandwidth: number;
  avgBandwidth: number;
  codecs: string;
  fps: number;
}

const SPEC: Record<number, { v: number; a: number; high: boolean }> = {
  240: { v: 250, a: 48, high: false },
  360: { v: 550, a: 64, high: false },
  480: { v: 1000, a: 96, high: true },
  720: { v: 2200, a: 96, high: true },
};
function specOf(r: number) {
  if (SPEC[r]) return SPEC[r];
  const k = Object.keys(SPEC).map(Number).sort((a, b) => Math.abs(a - r) - Math.abs(b - r))[0];
  return SPEC[k];
}

/** displayed (rotation-applied) size of the source */
export function displayed(p: Probe) {
  let w = p.video!.width;
  let h = p.video!.height;
  if (p.video!.rotation === 90 || p.video!.rotation === 270) [w, h] = [h, w];
  return { w, h };
}

/** Rungs for this source: every configured rung up to its short edge (no upscaling), at least one. */
export function ladderFor(p: Probe): number[] {
  const { w, h } = displayed(p);
  const short = Math.min(w, h, Math.round((Math.min(w, h) * VIDEO_MAX_EDGE) / Math.max(w, h)) || Infinity);
  const rungs = HLS_RUNGS.filter((r) => r <= short + 8); // 712p-ish phone exports still get 720
  if (!rungs.length) return [Math.max(2, Math.floor(short / 2) * 2)];
  return rungs;
}

/** One ffmpeg pass, one HLS output per rung. */
export async function encodeRungs(src: string, hlsDir: string, rungs: number[], p: Probe) {
  if (!rungs.length) return;
  const { w, h } = displayed(p);
  const portrait = h > w;
  const split = rungs.length > 1 ? `[0:v:0]split=${rungs.length}${rungs.map((_, i) => `[s${i}]`).join("")};` : "";
  const scales = rungs
    .map((r, i) => `${rungs.length > 1 ? `[s${i}]` : "[0:v:0]"}scale=${portrait ? `${r}:-2` : `-2:${r}`}:flags=bicubic,format=yuv420p[v${i}]`)
    .join(";");
  const args = ["-y", "-v", "error", "-i", src, "-filter_complex", split + scales];
  const timeoutMs = Math.max(10 * 60_000, 4 * p.durationMs * rungs.length);
  for (const [i, r] of rungs.entries()) {
    const s = specOf(r);
    const out = path.join(hlsDir, `r${r}`);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    args.push(
      "-map", `[v${i}]`,
      ...(p.audio ? ["-map", "0:a:0"] : []),
      "-c:v", "libx264", "-preset", "veryfast",
      "-profile:v", s.high ? "high" : "main", "-level:v", "3.1",
      "-crf", "23", "-maxrate", `${s.v}k`, "-bufsize", `${s.v * 2}k`,
      // closed GOP, IDR exactly every 2 s on the same timestamps in every rendition → aligned switch points
      "-g", "300", "-keyint_min", "1", "-sc_threshold", "0", "-force_key_frames", "expr:gte(t,n_forced*2)",
      "-fpsmax", "30",
      ...(p.audio ? ["-c:a", "aac", "-b:a", `${s.a}k`, "-ac", "2", "-ar", "48000"] : []),
      "-threads", String(FFMPEG_THREADS),
      "-map_metadata", "-1", "-map_chapters", "-1",
      // 2 s parts (one GOP each); regroup() then joins them into ~4 s segments after a short 2 s first one
      "-f", "hls", "-hls_time", "2", "-hls_list_size", "0", "-hls_playlist_type", "vod",
      "-hls_segment_type", "fmp4", "-hls_flags", "independent_segments",
      "-hls_fmp4_init_filename", "init.mp4",
      "-hls_segment_filename", path.join(out, "p_%05d.m4s"),
      path.join(out, "index.m3u8"),
    );
  }
  // lower CPU priority for the background ladder (nice is in coreutils; fall back to plain ffmpeg)
  const useNice = HLS_NICE > 0 && fs.existsSync("/usr/bin/nice");
  const r = await run(useNice ? "/usr/bin/nice" : FFMPEG, useNice ? ["-n", String(HLS_NICE), FFMPEG, ...args] : args, { timeoutMs });
  if (r.code !== 0) throw new MediaError(`hls encode failed: ${r.err.slice(-400)}`, 500);
  for (const rr of rungs) regroup(path.join(hlsDir, `r${rr}`));
}

/**
 * Join the 2 s fMP4 parts into segments: the first stays ~2 s (fast first frame), then pairs → ~4 s.
 * fMP4 fragments (moof+mdat) concatenate into a valid CMAF segment; every segment still starts on an IDR.
 */
export function regroup(dir: string) {
  const pl = fs.readFileSync(path.join(dir, "index.m3u8"), "utf8").split(/\r?\n/);
  const parts: { dur: number; file: string }[] = [];
  let dur = 0;
  for (const l of pl) {
    if (l.startsWith("#EXTINF:")) dur = parseFloat(l.slice(8));
    else if (l && !l.startsWith("#")) parts.push({ dur, file: l });
  }
  const groups: { dur: number; files: string[] }[] = [];
  parts.forEach((p, i) => {
    const last = groups[groups.length - 1];
    if (i === 0 || !last || last.files.length >= 2 || groups.length === 1) groups.push({ dur: p.dur, files: [p.file] });
    else {
      last.dur += p.dur;
      last.files.push(p.file);
    }
  });
  const out = ["#EXTM3U", "#EXT-X-VERSION:7", `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(Math.max(...groups.map((g) => g.dur), 1) - 0.001))}`, "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-INDEPENDENT-SEGMENTS", '#EXT-X-MAP:URI="init.mp4"'];
  groups.forEach((g, i) => {
    const name = `seg_${String(i).padStart(5, "0")}.m4s`;
    const fd = fs.openSync(path.join(dir, name), "w");
    for (const f of g.files) fs.writeSync(fd, fs.readFileSync(path.join(dir, f)));
    fs.closeSync(fd);
    for (const f of g.files) fs.rmSync(path.join(dir, f), { force: true });
    out.push(`#EXTINF:${g.dur.toFixed(6)},`, name);
  });
  out.push("#EXT-X-ENDLIST");
  const tmp = path.join(dir, ".index.m3u8.tmp");
  fs.writeFileSync(tmp, out.join("\n") + "\n");
  fs.renameSync(tmp, path.join(dir, "index.m3u8"));
}

/** Measure a finished rendition: size from init.mp4, peak/average bitrate from segment sizes and EXTINF. */
export async function rungInfo(hlsDir: string, r: number, hasAudio: boolean): Promise<RungInfo> {
  const dir = path.join(hlsDir, `r${r}`);
  const pl = fs.readFileSync(path.join(dir, "index.m3u8"), "utf8");
  if (!pl.includes("#EXT-X-ENDLIST")) throw new MediaError(`rendition ${r} incomplete`, 500);
  const lines = pl.split(/\r?\n/);
  let peak = 0;
  let bytes = 0;
  let secs = 0;
  let dur = 0;
  for (const l of lines) {
    if (l.startsWith("#EXTINF:")) dur = parseFloat(l.slice(8));
    else if (l && !l.startsWith("#")) {
      const size = fs.statSync(path.join(dir, l)).size;
      bytes += size;
      secs += dur;
      if (dur > 0.5) peak = Math.max(peak, (size * 8) / dur);
    }
  }
  const init = fs.statSync(path.join(dir, "init.mp4")).size;
  const pr = await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate", "-of", "json", path.join(dir, "init.mp4")], { stdout: true, timeoutMs: 20_000 });
  const st = (JSON.parse(pr.out.toString() || "{}").streams ?? [])[0] ?? {};
  const [fn, fd] = String(st.avg_frame_rate ?? "30/1").split("/").map(Number);
  const s = specOf(r);
  const avg = secs > 0 ? ((bytes + init) * 8) / secs : s.v * 1000;
  return {
    r,
    width: Number(st.width) || 0,
    height: Number(st.height) || 0,
    bandwidth: Math.ceil(Math.max(peak, avg) * 1.1),
    avgBandwidth: Math.ceil(avg),
    codecs: `${s.high ? "avc1.64001f" : "avc1.4d401f"}${hasAudio ? ",mp4a.40.2" : ""}`,
    fps: fd ? Math.min(30, fn / fd) : 30,
  };
}

function masterText(rungs: RungInfo[], first: number) {
  const sorted = [...rungs].sort((a, b) => a.bandwidth - b.bandwidth);
  const i = sorted.findIndex((x) => x.r === first);
  const ordered = i > 0 ? [sorted[i], ...sorted.filter((_, k) => k !== i)] : sorted;
  const out = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
  for (const x of ordered) {
    out.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${x.bandwidth},AVERAGE-BANDWIDTH=${x.avgBandwidth},RESOLUTION=${x.width}x${x.height},CODECS="${x.codecs}",FRAME-RATE=${x.fps.toFixed(3)}`,
      `r${x.r}/index.m3u8`,
    );
  }
  return out.join("\n") + "\n";
}

/** (Re)write master.m3u8 (360p first when present) and master-low.m3u8 (lowest first), atomically. */
export function writeMasters(hlsDir: string, rungs: RungInfo[]) {
  const write = (name: string, text: string) => {
    const tmp = path.join(hlsDir, `.${name}.tmp`);
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, path.join(hlsDir, name));
  };
  const low = Math.min(...rungs.map((x) => x.r));
  write("master-low.m3u8", masterText(rungs, low));
  write("master.m3u8", masterText(rungs, rungs.some((x) => x.r === 360) ? 360 : low));
}

export { probe };
