#!/usr/bin/env node
/**
 * Build a self-hosted Microsoft Fluent Emoji Animated library in resumable chunks.
 *
 * Source: https://github.com/microsoft/fluentui-emoji-animated (MIT)
 *
 * The official source stores 256px APNGs in Git LFS. This importer uses one default
 * animation per Unicode emoji, re-encodes it to a 160px animated WebP plus static
 * WebP poster, and writes the final runtime manifest and picker catalog only after
 * every asset has passed validation.
 *
 * Typical bounded workflow:
 *   FLUENT_SOURCE_DIR=/path/to/source node scripts/emoji/build-fluent.mjs --next 120
 *   # Repeat --next 120 until --status reports 746/746 complete.
 *   FLUENT_SOURCE_DIR=/path/to/source node scripts/emoji/build-fluent.mjs --finalize
 *
 * Options:
 *   --next <MiB>          Convert a bounded batch of incomplete assets, selected by
 *                         source-file size (default: 120 MiB when no value follows).
 *   --chunk <start> <n>   Convert a deterministic source-list slice; useful to retry
 *                         a specific range. Existing valid assets are skipped.
 *   --status              Print the persistent stage's validated completion state.
 *   --finalize            Verify all 746 assets, then publish them into the branch.
 *   --stage <path>        Override FLUENT_STAGE_DIR (/tmp/openlounge-fluent-build).
 *
 * Requirements: git-lfs and ffmpeg. Interrupted runs are safe: each output is written
 * to a temporary file and renamed only after validation; later chunks retry invalid
 * or incomplete pairs automatically.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = path.resolve(process.env.FLUENT_SOURCE_DIR || "/tmp/fluentui-emoji-animated-index");
const SOURCE_ASSETS = path.join(SOURCE, "assets");
const OUT = path.join(ROOT, "public", "emoji", "fluent");
const CATALOG = path.join(ROOT, "src", "lib", "emoji", "fluent.json");
const KEY_MODULE = path.join(ROOT, "src", "lib", "emoji", "fluentKeys.ts");
const ORIGIN = "https://github.com/microsoft/fluentui-emoji-animated";
const LICENSE_URL = `${ORIGIN}/blob/main/LICENSE`;
const SIZE = 160;
const CONCURRENCY = Math.max(1, Math.min(Number(process.env.FLUENT_BUILD_CONCURRENCY || 3), 4));
const execFileAsync = promisify(execFile);

const CATEGORIES = ["Smileys", "People", "Animals & Nature", "Food & Drink", "Activity", "Travel & Places", "Objects", "Symbols", "Flags"];
const CATEGORY_BY_GROUP = new Map([
  ["Smileys & Emotion", 0],
  ["People & Body", 1],
  ["Animals & Nature", 2],
  ["Food & Drink", 3],
  ["Activities", 4],
  ["Travel & Places", 5],
  ["Objects", 6],
  ["Symbols", 7],
  ["Flags", 8],
]);

function fail(message) {
  console.error(`\nError: ${message}`);
  process.exit(1);
}

function usage() {
  console.error("Usage: build-fluent.mjs (--status | --next [MiB] | --chunk <start> <count> | --finalize) [--stage <path>]");
  process.exit(2);
}

function command(bin, args, opts = {}) {
  const output = execFileSync(bin, args, { cwd: opts.cwd, encoding: "utf8", stdio: opts.stdio ?? ["ignore", "pipe", "pipe"] });
  return typeof output === "string" ? output.trim() : "";
}

function has(bin) {
  try {
    command(bin, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

function parsePositiveInt(raw, name) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) fail(`${name} must be a positive integer.`);
  return n;
}

function parseArgs(argv) {
  let mode = null;
  let start = null;
  let count = null;
  let budgetMiB = null;
  let stage = process.env.FLUENT_STAGE_DIR || "/tmp/openlounge-fluent-build";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--status" || arg === "--finalize") {
      if (mode) usage();
      mode = arg.slice(2);
    } else if (arg === "--next") {
      if (mode) usage();
      mode = "next";
      const candidate = argv[i + 1];
      if (candidate && !candidate.startsWith("--")) budgetMiB = parsePositiveInt(argv[++i], "--next MiB");
      else budgetMiB = 120;
    } else if (arg === "--chunk") {
      if (mode) usage();
      mode = "chunk";
      start = parsePositiveInt(argv[++i], "--chunk start") - 1;
      count = parsePositiveInt(argv[++i], "--chunk count");
    } else if (arg === "--stage") {
      stage = argv[++i] || usage();
    } else {
      usage();
    }
  }
  if (!mode) usage();
  return { mode, start, count, budgetBytes: budgetMiB ? budgetMiB * 1024 * 1024 : null, stage: path.resolve(stage) };
}

function listPng(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".png")).map((name) => path.join(dir, name)).sort();
}

function sourceAnimation(dir) {
  const direct = listPng(path.join(dir, "animated"));
  if (direct.length === 1) return direct[0];
  const fallback = listPng(path.join(dir, "Default", "animated"));
  if (fallback.length === 1) return fallback[0];
  fail(`Expected exactly one default animation in ${dir}; found direct=${direct.length}, Default=${fallback.length}`);
}

function isLfsPointer(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(160);
    const { bytesRead } = fs.readSync(fd, head, 0, head.length, 0);
    return head.subarray(0, bytesRead).toString("utf8").startsWith("version https://git-lfs.github.com/spec/v1");
  } finally {
    fs.closeSync(fd);
  }
}

function emojiKey(codepoints) {
  const key = codepoints
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((codepoint) => codepoint !== "fe0f" && codepoint !== "fe0e")
    .join("_");
  if (!/^[0-9a-f]+(?:_[0-9a-f]+)*$/.test(key)) fail(`Invalid Unicode codepoint list: ${codepoints}`);
  return key;
}

function apngDurationMs(file) {
  const input = fs.readFileSync(file);
  let offset = 8;
  let total = 0;
  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.subarray(offset + 4, offset + 8).toString("ascii");
    const data = offset + 8;
    if (type === "fcTL" && length >= 26) {
      const numerator = input.readUInt16BE(data + 20);
      const denominator = input.readUInt16BE(data + 22) || 100;
      total += (numerator / denominator) * 1000;
    }
    offset += length + 12;
    if (type === "IEND") break;
  }
  return Math.max(800, Math.round(total || 3000));
}

function isAnimatedWebp(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) return false;
  const data = fs.readFileSync(file);
  return data.includes(Buffer.from("ANIM")) && data.toString("latin1").split("ANMF").length - 1 > 1;
}

function posterIsValid(file) {
  return fs.existsSync(file) && fs.statSync(file).size > 0;
}

function itemPaths(stage, item) {
  return { animation: path.join(stage, `${item.key}.webp`), poster: path.join(stage, "p", `${item.key}.webp`) };
}

function itemComplete(stage, item) {
  const { animation, poster } = itemPaths(stage, item);
  return isAnimatedWebp(animation) && posterIsValid(poster);
}

function countState(stage, items) {
  let complete = 0;
  let partial = 0;
  for (const item of items) {
    const { animation, poster } = itemPaths(stage, item);
    const animationOk = isAnimatedWebp(animation);
    const posterOk = posterIsValid(poster);
    if (animationOk && posterOk) complete++;
    else if (fs.existsSync(animation) || fs.existsSync(poster)) partial++;
  }
  return { complete, partial, missing: items.length - complete - partial };
}

function outputBytes(stage, items) {
  return items.reduce((total, item) => {
    const { animation, poster } = itemPaths(stage, item);
    return total + (fs.existsSync(animation) ? fs.statSync(animation).size : 0) + (fs.existsSync(poster) ? fs.statSync(poster).size : 0);
  }, 0);
}

function ensureHydrated(items) {
  const pointers = items.filter((item) => isLfsPointer(item.input));
  if (!pointers.length) return;
  console.log(`Hydrating ${pointers.length} selected APNGs through Git LFS…`);
  command("git", ["lfs", "pull", "--include=assets/*/animated/*.png,assets/*/Default/animated/*.png", "--exclude="], { cwd: SOURCE, stdio: "inherit" });
  for (const item of items) if (isLfsPointer(item.input)) fail(`Git LFS did not hydrate ${item.input}`);
}

async function convert(input, animationOut, posterOut) {
  const scale = `scale=${SIZE}:${SIZE}:flags=lanczos`;
  const suffix = `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const animationTmp = `${animationOut.slice(0, -".webp".length)}${suffix}.webp`;
  const posterTmp = `${posterOut.slice(0, -".webp".length)}${suffix}.webp`;
  try {
    await execFileAsync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vf", scale, "-loop", "0", "-c:v", "libwebp_anim", "-lossless", "0", "-q:v", "78", "-compression_level", "6", animationTmp]);
    if (!isAnimatedWebp(animationTmp)) fail(`Animated WebP validation failed for ${input}`);
    await execFileAsync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", input, "-vf", scale, "-frames:v", "1", "-c:v", "libwebp", "-lossless", "0", "-q:v", "82", "-compression_level", "6", posterTmp]);
    if (!posterIsValid(posterTmp)) fail(`Poster validation failed for ${input}`);
    fs.renameSync(animationTmp, animationOut);
    fs.renameSync(posterTmp, posterOut);
  } finally {
    fs.rmSync(animationTmp, { force: true });
    fs.rmSync(posterTmp, { force: true });
  }
}

async function pool(items, worker) {
  let cursor = 0;
  let completed = 0;
  const run = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]);
      completed++;
      if (completed % 10 === 0 || completed === items.length) console.log(`Converted ${completed}/${items.length} assets in this chunk`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, value);
  fs.renameSync(tmp, file);
}

const args = parseArgs(process.argv.slice(2));
if (!fs.existsSync(SOURCE_ASSETS) || !fs.existsSync(path.join(SOURCE, ".git"))) fail(`Official source checkout not found at ${SOURCE}.`);
if (!has("ffmpeg")) fail("ffmpeg is required to build animated WebP assets.");
try {
  command("git", ["lfs", "version"], { cwd: SOURCE });
} catch {
  fail("git-lfs is required to retrieve official APNG source files.");
}

const revision = command("git", ["rev-parse", "HEAD"], { cwd: SOURCE });
const dirs = fs.readdirSync(SOURCE_ASSETS, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(SOURCE_ASSETS, entry.name)).sort();
const items = dirs.map((dir, index) => {
  const metadata = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8"));
  const category = CATEGORY_BY_GROUP.get(metadata.group);
  if (category === undefined) fail(`Unknown Fluent group "${metadata.group}" for ${metadata.tts}`);
  const input = sourceAnimation(dir);
  return { index, dir, metadata, key: emojiKey(metadata.unicode), category, input, inputBytes: fs.statSync(input).size };
});
if (items.length !== 746) fail(`Expected 746 official Fluent base emoji assets, found ${items.length}.`);
if (new Set(items.map((item) => item.key)).size !== items.length) fail("The official Fluent source contains duplicate normalized Unicode keys.");

if (args.mode === "status") {
  const state = countState(args.stage, items);
  const bytes = outputBytes(args.stage, items);
  console.log(JSON.stringify({ stage: args.stage, revision, total: items.length, ...state, outputMiB: Number((bytes / 1024 / 1024).toFixed(1)) }, null, 2));
  process.exit(0);
}

if (args.mode === "finalize") {
  const state = countState(args.stage, items);
  if (state.complete !== items.length || state.partial) fail(`Stage is incomplete: ${state.complete}/${items.length} validated, ${state.partial} partial, ${state.missing} missing.`);
  if (fs.existsSync(OUT)) fail(`Refusing to replace existing ${OUT}; inspect it or remove it explicitly before finalizing.`);

  const records = items.map((item) => {
    const { animation, poster } = itemPaths(args.stage, item);
    return {
      key: item.key,
      emoji: item.metadata.glyph,
      name: item.metadata.tts,
      group: item.metadata.group,
      tags: item.metadata.keywords,
      cat: item.category,
      durationMs: apngDurationMs(item.input),
      bytes: fs.statSync(animation).size,
      posterBytes: fs.statSync(poster).size,
    };
  }).sort((a, b) => a.key.localeCompare(b.key));
  const files = Object.fromEntries(records.map(({ key, ...record }) => [key, record]));
  const manifest = {
    source: "Microsoft Fluent Emoji Animated",
    license: "MIT",
    licenseUrl: LICENSE_URL,
    origin: ORIGIN,
    revision,
    encoding: `animated WebP ${SIZE}x${SIZE} plus static WebP posters`,
    count: records.length,
    files,
  };
  fs.copyFileSync(path.join(SOURCE, "LICENSE"), path.join(args.stage, "LICENSE"));
  atomicWrite(path.join(args.stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.renameSync(args.stage, OUT);
  atomicWrite(CATALOG, JSON.stringify({ cats: CATEGORIES, rows: records.map((record) => [record.emoji, record.key, record.name.toLowerCase(), record.cat, record.durationMs]) }) + "\n");
  atomicWrite(KEY_MODULE, `// GENERATED by scripts/emoji/build-fluent.mjs — do not edit by hand.\nexport const FLUENT_KEYS = ${JSON.stringify(records.map((record) => `${record.key}:${record.durationMs}`).join(" "))};\n`);
  const totalBytes = records.reduce((sum, record) => sum + record.bytes + record.posterBytes, 0);
  console.log(`Finalized ${records.length} self-hosted Fluent emoji assets: ${(totalBytes / 1024 / 1024).toFixed(1)} MiB at ${SIZE}px.`);
  process.exit(0);
}

let selected;
if (args.mode === "chunk") {
  selected = items.slice(args.start, args.start + args.count);
  if (!selected.length) fail(`Chunk start ${args.start + 1} is outside the 746-item source list.`);
} else {
  const incomplete = items.filter((item) => !itemComplete(args.stage, item));
  selected = [];
  let selectedBytes = 0;
  for (const item of incomplete) {
    if (selected.length && selectedBytes + item.inputBytes > args.budgetBytes) break;
    selected.push(item);
    selectedBytes += item.inputBytes;
  }
  if (!selected.length) {
    console.log("No incomplete Fluent assets remain. Run --finalize to publish the verified stage.");
    process.exit(0);
  }
  console.log(`Selected ${selected.length} incomplete assets (${(selectedBytes / 1024 / 1024).toFixed(1)} MiB source budget) from ${incomplete.length} remaining.`);
}

ensureHydrated(selected);
fs.mkdirSync(path.join(args.stage, "p"), { recursive: true });
const pending = selected.filter((item) => !itemComplete(args.stage, item));
console.log(`Converting ${pending.length}/${selected.length} assets at ${CONCURRENCY}-way concurrency into ${args.stage}`);
await pool(pending, async (item) => {
  const { animation, poster } = itemPaths(args.stage, item);
  await convert(item.input, animation, poster);
});
const state = countState(args.stage, items);
console.log(`Chunk complete. Persistent stage: ${state.complete}/${items.length} validated, ${state.partial} partial, ${state.missing} missing.`);
