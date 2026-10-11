// Animated emoji sources — one pluggable map from an emoji to its animated asset, with a fallback chain.
//
//   telegram (default everywhere): self-hosted animated WebP, 160 px, in /emoji/telegram/<key>.webp (+ /emoji/telegram/p/<key>.webp
//            first-frame posters, 128 px; manifest.json alongside). Rendered with a plain <img> (native decoder, cheap).
//   noto:    Google Noto Animated Emoji (Lottie JSON, CC BY 4.0 — "Animated emoji by Google"), the full set self-hosted in
//            /emoji/noto/<key>.json (+ posters in /emoji/noto/p/<key>.webp, manifest.json), rendered with lottie-web's light
//            canvas build, lazy-loaded only when a Lottie emoji is actually shown.
//
// Load order for an emoji (assetChain): 1) our Telegram copy → 2) the upstream Telegram file (raw.githubusercontent.com — what
// telegram-emojis.vercel.app itself renders) if ours errors or doesn't paint within ~3 s → 3) our Noto copy → 4) the native glyph.
// Emoji Telegram's set lacks start at Noto. The switch is internal: NEXT_PUBLIC_EMOJI_SOURCE (build),
// NEXT_PUBLIC_EMOJI_SOURCE_{WEB,IOS,ANDROID} (per platform), and — outside production builds or with localStorage "ol:dev" = "1" —
// localStorage "ol:emojiSet" / ?emojiSet= for side-by-side comparisons (noto first, then Telegram).
// Keys are lower-case hex code points without FE0F, joined by "_" (❤️ → "2764", 👍🏽 → "1f44d_1f3fd").

import { linkSlow } from "@/lib/dataSaver";
import { afterCritical } from "@/lib/media/critical";
import { NOTO_KEYS, TG_KEYS } from "./keys";

export type EmojiSource = "telegram" | "noto";
export type EmojiAsset =
  | { type: "webp"; src: string; poster: string | null; durationMs: number; source: "telegram"; remote?: boolean }
  | { type: "lottie"; src: string; poster: string; durationMs: number; source: "noto"; remote?: false };

const tgDur = new Map<string, number>();
for (const pair of TG_KEYS.split(" ")) {
  const [k, cs] = pair.split(":");
  tgDur.set(k, Number(cs) * 10);
}
const noto = new Set(NOTO_KEYS.split(" "));

export function emojiKey(emoji: string): string {
  const out: string[] = [];
  for (const ch of emoji) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0xfe0f || cp === 0xfe0e) continue;
    out.push(cp.toString(16));
  }
  return out.join("_");
}

const VALID = new Set<EmojiSource>(["telegram", "noto"]);
let cached: EmojiSource | null = null;

function platform(): "web" | "ios" | "android" {
  if (typeof window === "undefined") return "web";
  try {
    const p = (window as unknown as { OpenLoungeNative?: { getPlatform?: () => string } }).OpenLoungeNative?.getPlatform?.();
    return p === "ios" || p === "android" ? p : "web";
  } catch {
    return "web";
  }
}

/** The preferred animated emoji source for this device (see header). Telegram unless configured otherwise. */
export function emojiSource(): EmojiSource {
  if (cached) return cached;
  let pick: string | undefined;
  if (typeof window !== "undefined") {
    try {
      const devOk = process.env.NODE_ENV !== "production" || localStorage.getItem("ol:dev") === "1";
      if (devOk) {
        const q = new URLSearchParams(location.search).get("emojiSet");
        if (q && VALID.has(q as EmojiSource)) localStorage.setItem("ol:emojiSet", q);
        pick = localStorage.getItem("ol:emojiSet") ?? undefined;
      }
    } catch {
      /* storage blocked */
    }
  }
  const plat = platform();
  const perPlatform =
    plat === "ios" ? process.env.NEXT_PUBLIC_EMOJI_SOURCE_IOS : plat === "android" ? process.env.NEXT_PUBLIC_EMOJI_SOURCE_ANDROID : process.env.NEXT_PUBLIC_EMOJI_SOURCE_WEB;
  for (const c of [pick, perPlatform, process.env.NEXT_PUBLIC_EMOJI_SOURCE, "telegram"]) {
    if (c && VALID.has(c as EmojiSource)) {
      if (typeof window !== "undefined") cached = c as EmojiSource;
      return c as EmojiSource;
    }
  }
  return "telegram";
}

/** Dev/compare only: switch the set at runtime (components re-read it on mount). */
export function setEmojiSourceOverride(s: EmojiSource | null) {
  try {
    if (s) localStorage.setItem("ol:emojiSet", s);
    else localStorage.removeItem("ol:emojiSet");
  } catch {
    /* ignore */
  }
  cached = null;
}

function tgAsset(k: string): EmojiAsset | null {
  const d = tgDur.get(k);
  return d === undefined ? null : { type: "webp", src: `/emoji/telegram/${k}.webp`, poster: `/emoji/telegram/p/${k}.webp`, durationMs: d, source: "telegram" };
}
function notoAsset(k: string): EmojiAsset | null {
  return noto.has(k) ? { type: "lottie", src: `/emoji/noto/${k}.json`, poster: `/emoji/noto/p/${k}.webp`, durationMs: 0, source: "noto" } : null;
}

const memo = new Map<string, EmojiAsset | null>();
/** Animated asset for one emoji from the preferred source, else the other one; null → render the native glyph. */
export function animatedAsset(emoji: string, source: EmojiSource = emojiSource()): EmojiAsset | null {
  const id = `${source}|${emoji}`;
  if (memo.has(id)) return memo.get(id)!;
  const k = emojiKey(emoji);
  // "❤" typed without FE0F and "❤️" share a key; ZWJ sequences may also be stored with / without FE0F
  const a = source === "noto" ? notoAsset(k) ?? tgAsset(k) : tgAsset(k) ?? notoAsset(k);
  memo.set(id, a);
  return a;
}

// ---- fallback chain ----
// A step is either a ready asset or the (lazily resolved) upstream Telegram file. Session health: after 3 failures of a tier
// we stop trying it first, so a dead origin costs three timeouts, not one per emoji.
export type ChainStep = EmojiAsset | { type: "remote"; key: string; durationMs: number };
const failures = { local: 0, remote: 0 };
export const FALLBACK_TIMEOUT_MS = 3000;
export const REMOTE_TIMEOUT_MS = 6000;
export function noteAssetFailure(step: ChainStep) {
  if (step.type === "remote" || (step.type === "webp" && step.remote)) failures.remote++;
  else if (step.type === "webp") failures.local++;
}
/** Ordered sources to try for one emoji. `animated` = false (static posters) skips the upstream file (it has no poster). */
export function assetChain(emoji: string, source: EmojiSource = emojiSource(), animated = true): ChainStep[] {
  const k = emojiKey(emoji);
  const tg = tgAsset(k);
  const tgSteps: ChainStep[] = [];
  if (tg) {
    if (failures.local < 3) tgSteps.push(tg);
    if (animated && failures.remote < 3) tgSteps.push({ type: "remote", key: k, durationMs: tg.durationMs });
    if (!tgSteps.length) tgSteps.push(tg);
  }
  const n = notoAsset(k);
  return source === "noto" ? [...(n ? [n] : []), ...tgSteps] : [...tgSteps, ...(n ? [n] : [])];
}
let remoteMod: Promise<typeof import("./tgRemote")> | null = null;
/** Resolve the upstream Telegram file for a key (separate chunk, loaded only on the first local failure). */
export async function resolveRemote(step: { key: string; durationMs: number }): Promise<EmojiAsset | null> {
  remoteMod ??= import("./tgRemote");
  const url = (await remoteMod).tgRemoteUrl(step.key);
  return url ? { type: "webp", src: url, poster: null, durationMs: step.durationMs, source: "telegram", remote: true } : null;
}

export const hasAnimated = (emoji: string) => animatedAsset(emoji) !== null;
/** Is Google's Noto set in use at all on this device (for the CC BY attribution line)? */
export const notoInUse = () => true; // Noto always backs emoji Telegram's set lacks

/** The 8 quick reactions (Telegram order-ish). */
export const QUICK_REACTIONS = ["❤️", "👍", "😂", "😮", "😢", "🔥", "👏", "🎉"] as const;

/** Warm the HTTP cache for the quick reactions' animations + posters (call once a chat opens). */
let preloaded = false;
export function preloadQuickReactions() {
  if (preloaded || typeof window === "undefined") return;
  preloaded = true;
  const run = () => {
    // slow link / data saver: just the small posters; the animations load when the reaction bar opens
    const postersOnly = linkSlow();
    for (const e of QUICK_REACTIONS) {
      const a = animatedAsset(e);
      if (!a) continue;
      for (const url of postersOnly ? [a.poster] : [a.src, a.poster]) {
        if (!url) continue;
        const img = a.type === "webp" || url === a.poster ? new Image() : null;
        if (img) {
          img.decoding = "async";
          img.src = url;
        } else fetch(url).catch(() => {});
      }
    }
  };
  // after the chat's on-screen thumbnails/posters (~1 MB of animations would otherwise starve them on slow links)
  afterCritical(run, 5);
}

/** 1–3 emoji (and whitespace) and nothing else → big animated emoji, no bubble. Returns the emoji or null. */
const SEG = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const ONE_EMOJI = /^(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*)$/u;
export function bigEmoji(text: string): string[] | null {
  const t = text.replace(/\s+/g, "");
  if (!t || t.length > 40) return null;
  const parts = SEG ? [...SEG.segment(t)].map((s) => s.segment) : [...t];
  if (parts.length < 1 || parts.length > 3) return null;
  return parts.every((p) => ONE_EMOJI.test(p)) ? parts : null;
}
