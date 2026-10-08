#!/usr/bin/env node
// Builds the free starter sticker packs from Google's Noto Animated Emoji (CC BY 4.0,
// https://googlefonts.github.io/noto-emoji-animation/). For every sticker it downloads the Lottie JSON and the
// 512px animated WebP from fonts.gstatic.com, then writes:
//   public/sticker-files/noto/<cp>.<hash>.json.gz   Lottie animation (gzipped, served with Content-Encoding: gzip)
//   public/sticker-files/noto/<cp>.<hash>.webp      256px static poster (first frame; instant paint, reduced motion)
// and the pack manifest server/stickers/noto-packs.json. Re-runnable; cached downloads live in /tmp/noto-cache.
// Usage: node scripts/stickers/build-noto-packs.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sharp = require("sharp");

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const OUT = path.join(ROOT, "public/sticker-files/noto");
const CACHE = "/tmp/noto-cache";
const BASE = "https://fonts.gstatic.com/s/e/notoemoji/latest";
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(CACHE, { recursive: true });

const PACKS = [
  {
    id: "noto-faces", title: "Faces", emoji: "😀", category: "Emotions",
    description: "Big animated faces for every mood.",
    cps: "1f600 1f603 1f604 1f601 1f606 1f605 1f602 1f923 1f62d 1f609 1f618 1f970 1f60d 1f929 1f973 1fae0 1f643 1f972 1f979 1f60a 1f60f 1f60b 1f61c 1f92a 1f97a 1f62c 1fae1 1f914 1f92b 1fae2 1f971 1f917 1fae3 1f631 1f928 1f644 1f624 1f621 1f92f 1f974 1f975 1f976 1f634 1f60e 1f913 1f607 1f920 1f921 1f47b 1f480 1f916 1f4a9",
  },
  {
    id: "noto-love", title: "Hearts & Love", emoji: "❤️", category: "Love",
    description: "Hearts that beat, glow, grow and mend.",
    cps: "2764_fe0f 1f9e1 1f49b 1f49a 1fa75 1f499 1f49c 1f5a4 1f90d 1fa77 1f498 1f49d 1f496 1f497 1f493 1f49e 1f495 1f48c 2763_fe0f 2764_fe0f_200d_1fa79 1f494 2764_fe0f_200d_1f525 1f48b 1fac2 1faf6 1f339 1f490 1f63b",
  },
  {
    id: "noto-hands", title: "Hands", emoji: "👋", category: "Gestures",
    description: "Waves, claps, thumbs and high fives.",
    cps: "1f44b 1f44d 1f44e 1f44f 1f64c 1faf6 1f64f 1f91d 1f4aa 270c_fe0f 1f91e 1f91f 1f918 1f919 1f44c 1f90c 1f90f 1faf5 1f449 1f448 1f446 1f447 261d_fe0f 270a 1f44a 1f91c 1f91b 270b 1f596 1f450 1f932 270d_fe0f 1f933 1f485",
  },
  {
    id: "noto-animals", title: "Animals", emoji: "🦊", category: "Animals",
    description: "Lions, foxes, penguins, octopuses and friends.",
    cps: "1f981 1f43a 1f43b 1f43c 1f98a 1f42e 1f984 1f409 1f996 1f422 1f438 1f407 1f429 1f415 1f416 1f405 1f412 1f9a5 1f99d 1f994 1f9a6 1f987 1f426 1f423 1f425 1f989 1f9a9 1f99a 1f426_200d_1f525 1f427 1f9ad 1f988 1f42c 1f433 1f421 1f980 1f419 1fabc 1f40c 1f41d 1f98b 1f63a 1f639 1f648 1f649 1f64a",
  },
  {
    id: "noto-party", title: "Celebrations", emoji: "🎉", category: "Celebrations",
    description: "Confetti, cake, fireworks and trophies.",
    cps: "1f389 1f38a 1f388 1f382 1f381 1f386 1fa85 1faa9 1f3c6 1f947 1f451 1f942 1f37e 1f37b 2728 1f31f 1f525 1f4af 1f4a5 26a1 1f308 1f680 1f48e 1f4b8 1f483 1f3b6 1f3b8 1f941 1fa84 1f52e 1f3af 1f3c1",
  },
];

const api = JSON.parse(fs.readFileSync("/tmp/noto-api.json", "utf8"));
const meta = new Map(api.icons.map((i) => [i.codepoint, i]));
const toEmoji = (cp) => String.fromCodePoint(...cp.split("_").map((h) => parseInt(h, 16)));

async function get(url, file) {
  const f = path.join(CACHE, file);
  if (fs.existsSync(f) && fs.statSync(f).size > 0) return fs.readFileSync(f);
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url).catch(() => null);
    if (r?.ok) {
      const b = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(f, b);
      return b;
    }
    await new Promise((res) => setTimeout(res, 500 * (i + 1)));
  }
  throw new Error(`download failed: ${url}`);
}

const done = new Map();
async function build(cp) {
  if (done.has(cp)) return done.get(cp);
  const m = meta.get(cp);
  if (!m) throw new Error(`not in Noto animated set: ${cp}`);
  const lottie = await get(`${BASE}/${cp}/lottie.json`, `${cp}.json`);
  const webp = await get(`${BASE}/${cp}/512.webp`, `${cp}.webp`);
  const json = JSON.parse(lottie.toString("utf8"));
  const min = Buffer.from(JSON.stringify(json));
  const hash = crypto.createHash("sha256").update(min).digest("hex").slice(0, 10);
  const gz = zlib.gzipSync(min, { level: 9 });
  const poster = await sharp(webp, { page: 0 }).resize(256, 256).webp({ quality: 82, alphaQuality: 90 }).toBuffer();
  const lf = `${cp}.${hash}.json.gz`;
  const pf = `${cp}.${hash}.webp`;
  fs.writeFileSync(path.join(OUT, lf), gz);
  fs.writeFileSync(path.join(OUT, pf), poster);
  const s = {
    id: cp,
    emoji: toEmoji(cp),
    keywords: m.tags.map((t) => t.replace(/:/g, "").replace(/-/g, " ")),
    format: "lottie",
    file: `noto/${lf}`,
    poster: `noto/${pf}`,
    w: json.w,
    h: json.h,
    bytes: gz.length,
  };
  done.set(cp, s);
  return s;
}

const out = [];
for (const p of PACKS) {
  const ids = p.cps.split(/\s+/).filter(Boolean);
  const stickers = [];
  for (let i = 0; i < ids.length; i += 8) stickers.push(...(await Promise.all(ids.slice(i, i + 8).map(build))));
  out.push({
    id: p.id, title: p.title, emoji: p.emoji, category: p.category, description: p.description,
    priceCents: 0, currency: "USD", published: true, builtin: true,
    cover: stickers[0].id,
    attribution: {
      text: "Animated emoji from Noto Emoji by Google, licensed under CC BY 4.0. Resized and repackaged as stickers by Open Lounge.",
      author: "Google (Noto Emoji)",
      source: "https://googlefonts.github.io/noto-emoji-animation/",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    },
    stickers,
  });
  console.log(`${p.id}: ${stickers.length} stickers`);
}
fs.writeFileSync(path.join(ROOT, "server/stickers/noto-packs.json"), JSON.stringify({ generatedAt: new Date().toISOString(), packs: out }, null, 1) + "\n");
// prune stale files from earlier runs
const keep = new Set([...done.values()].flatMap((s) => [path.basename(s.file), path.basename(s.poster)]));
for (const f of fs.readdirSync(OUT)) if (!keep.has(f)) fs.rmSync(path.join(OUT, f));
const total = [...done.values()].reduce((a, s) => a + s.bytes, 0);
console.log(`${done.size} unique stickers, lottie total ${(total / 1024).toFixed(0)} KB gz`);
