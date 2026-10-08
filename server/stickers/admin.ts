// Admin tool backend: create a pack (FREE by default), upload stickers (WebP/PNG, static or animated, or Lottie JSON),
// set a price tier ($0.99 / $1.99 / $2.99) and publish. Files live on the volume: $DATA_DIR/stickers/<packId>/…
// and are served at /sticker-files/u/<packId>/<file>.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import { DATA_DIR } from "../persistence";
import { STICKER_ID_RE } from "../../src/lib/stickers/token";
import type { Attribution, Sticker, StickerPack } from "../../src/lib/stickers/types";
import { validPrice, type StickerService } from "./service";

export const UPLOAD_DIR = path.join(DATA_DIR, "stickers");
const MAX_IMAGE = 1_000_000; // decoded bytes
const MAX_LOTTIE = 600_000;
const MAX_STICKERS = 120;

type R<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };
const fail = (status: number, error: string) => ({ ok: false as const, status, error });
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function slug(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "pack";
}

function attributionOf(v: unknown): Attribution | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  const out = { text: str(a.text, 400), author: str(a.author, 120), source: str(a.source, 300), license: str(a.license, 60), licenseUrl: str(a.licenseUrl, 300) };
  if (out.source && !/^https:\/\//.test(out.source)) out.source = "";
  if (out.licenseUrl && !/^https:\/\//.test(out.licenseUrl)) out.licenseUrl = "";
  return out.text || out.author ? out : null;
}

export async function createPack(svc: StickerService, by: string, body: Record<string, unknown>): Promise<R<{ pack: StickerPack }>> {
  const title = str(body.title, 60);
  if (!title) return fail(400, "Title required");
  // FREE unless a price tier is explicitly set (Telegram model: nearly everything free)
  const price = body.priceCents === undefined || body.priceCents === "" ? null : body.priceCents;
  if (!validPrice(price)) return fail(400, "Price must be Free, $0.99, $1.99 or $2.99");
  const id = `p-${slug(title)}-${randomBytes(2).toString("hex")}`;
  const pack: StickerPack = {
    id,
    title,
    emoji: str(body.emoji, 16) || "✨",
    category: str(body.category, 40) || "Other",
    description: str(body.description, 300),
    // Premium exclusive packs are never sold separately
    priceCents: body.premium === true ? null : price || null,
    premium: body.premium === true,
    currency: "USD",
    published: false,
    cover: "",
    attribution: attributionOf(body.attribution),
    stickers: [],
  };
  await svc.repo.savePack(pack, by);
  await svc.reload();
  return { ok: true, pack };
}

export async function updatePack(svc: StickerService, by: string, id: string, body: Record<string, unknown>): Promise<R<{ pack: StickerPack }>> {
  const cur = svc.pack(id, { includeDrafts: true });
  if (!cur) return fail(404, "Pack not found");
  if (cur.builtin) return fail(400, "Built-in packs can't be edited");
  const next: StickerPack = structuredClone(cur);
  if (body.title !== undefined) next.title = str(body.title, 60) || cur.title;
  if (body.emoji !== undefined) next.emoji = str(body.emoji, 16) || cur.emoji;
  if (body.category !== undefined) next.category = str(body.category, 40) || cur.category;
  if (body.description !== undefined) next.description = str(body.description, 300);
  if (body.attribution !== undefined) next.attribution = attributionOf(body.attribution);
  if (body.priceCents !== undefined) {
    const price = body.priceCents === "" ? null : body.priceCents;
    if (!validPrice(price)) return fail(400, "Price must be Free, $0.99, $1.99 or $2.99");
    next.priceCents = price || null;
  }
  if (body.premium !== undefined) next.premium = body.premium === true;
  if (next.premium) next.priceCents = null; // Premium exclusives are never sold separately
  if (body.cover !== undefined && typeof body.cover === "string" && next.stickers.some((s) => s.id === body.cover)) next.cover = body.cover;
  if (body.order !== undefined && Array.isArray(body.order)) {
    const pos = new Map((body.order as unknown[]).map((x, i) => [String(x), i]));
    next.stickers.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  }
  if (body.published !== undefined) {
    if (body.published === true && next.stickers.length === 0) return fail(400, "Add at least one sticker before publishing");
    next.published = body.published === true;
  }
  await svc.repo.savePack(next, by);
  await svc.reload();
  return { ok: true, pack: next };
}

function decodeDataUrl(v: unknown): { mime: string; buf: Buffer } | null {
  if (typeof v !== "string") return null;
  const m = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(v);
  if (!m) return null;
  return { mime: m[1], buf: Buffer.from(m[2], "base64") };
}

function validLottie(j: unknown): j is { w: number; h: number; fr: number; ip: number; op: number; layers: unknown[] } {
  if (!j || typeof j !== "object") return false;
  const o = j as Record<string, unknown>;
  return typeof o.w === "number" && typeof o.h === "number" && typeof o.fr === "number" && typeof o.op === "number" && Array.isArray(o.layers) && o.w <= 1024 && o.h <= 1024 && o.fr <= 120 && (o.op as number) / (o.fr as number) <= 10;
}

/** body: { emoji, keywords?: string[], file: dataURL (image/webp|png|gif) | lottie: string|object, poster?: dataURL } */
export async function addSticker(svc: StickerService, by: string, packId: string, body: Record<string, unknown>): Promise<R<{ pack: StickerPack; sticker: Sticker }>> {
  const cur = svc.pack(packId, { includeDrafts: true });
  if (!cur) return fail(404, "Pack not found");
  if (cur.builtin) return fail(400, "Built-in packs can't be edited");
  if (cur.stickers.length >= MAX_STICKERS) return fail(400, `A pack holds up to ${MAX_STICKERS} stickers`);
  const emoji = str(body.emoji, 16);
  if (!emoji) return fail(400, "Pick the emoji this sticker stands for");
  const keywords = Array.isArray(body.keywords) ? (body.keywords as unknown[]).map((k) => str(k, 30).toLowerCase()).filter(Boolean).slice(0, 12) : [];
  const sid = `s${randomBytes(4).toString("hex")}`;
  const dir = path.join(UPLOAD_DIR, packId);
  fs.mkdirSync(dir, { recursive: true });
  const sharp = (await import("sharp")).default;
  let sticker: Sticker;

  const posterFrom = async (buf: Buffer) => {
    const out = await sharp(buf, { page: 0 }).resize(256, 256, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 82 }).toBuffer();
    const h = createHash("sha256").update(out).digest("hex").slice(0, 10);
    const f = `${sid}.p.${h}.webp`;
    fs.writeFileSync(path.join(dir, f), out);
    return `u/${packId}/${f}`;
  };

  if (body.lottie !== undefined) {
    let j: unknown;
    try {
      j = typeof body.lottie === "string" ? JSON.parse(body.lottie) : body.lottie;
    } catch {
      return fail(400, "That Lottie file isn't valid JSON");
    }
    const min = Buffer.from(JSON.stringify(j));
    if (min.length > MAX_LOTTIE) return fail(400, "Lottie file is too large (600 KB max)");
    if (!validLottie(j)) return fail(400, "Not a Lottie animation (needs w/h ≤ 1024, ≤ 10 s)");
    const h = createHash("sha256").update(min).digest("hex").slice(0, 10);
    const f = `${sid}.${h}.json.gz`;
    const gz = zlib.gzipSync(min, { level: 9 });
    fs.writeFileSync(path.join(dir, f), gz);
    const p = decodeDataUrl(body.poster);
    sticker = { id: sid, emoji, keywords, format: "lottie", file: `u/${packId}/${f}`, poster: p ? await posterFrom(p.buf).catch(() => "") : "", w: j.w, h: j.h, bytes: gz.length };
  } else {
    const d = decodeDataUrl(body.file);
    if (!d || !/^image\/(webp|png|gif)$/.test(d.mime)) return fail(400, "Upload a WebP, PNG or GIF (or a Lottie .json)");
    if (d.buf.length > MAX_IMAGE) return fail(400, "Image is too large (1 MB max)");
    let meta;
    try {
      meta = await sharp(d.buf, { animated: true }).metadata();
    } catch {
      return fail(400, "That image couldn't be read");
    }
    const animated = (meta.pages ?? 1) > 1;
    // normalise to ≤512px WebP (animation kept); stickers are square-ish with transparency
    const out = await sharp(d.buf, { animated })
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: animated ? 70 : 85, alphaQuality: 90, effort: 4 })
      .toBuffer();
    const h = createHash("sha256").update(out).digest("hex").slice(0, 10);
    const f = `${sid}.${h}.webp`;
    fs.writeFileSync(path.join(dir, f), out);
    const fileRef = `u/${packId}/${f}`;
    sticker = { id: sid, emoji, keywords, format: "webp", file: fileRef, poster: animated ? await posterFrom(d.buf) : fileRef, w: meta.width, h: meta.pageHeight ?? meta.height, bytes: out.length };
  }
  const next = structuredClone(cur);
  next.stickers.push(sticker);
  if (!next.cover) next.cover = sticker.id;
  await svc.repo.savePack(next, by);
  await svc.reload();
  return { ok: true, pack: next, sticker };
}

export async function removeSticker(svc: StickerService, by: string, packId: string, stickerId: string): Promise<R<{ pack: StickerPack }>> {
  const cur = svc.pack(packId, { includeDrafts: true });
  if (!cur) return fail(404, "Pack not found");
  if (cur.builtin) return fail(400, "Built-in packs can't be edited");
  if (!STICKER_ID_RE.test(stickerId) || !cur.stickers.some((s) => s.id === stickerId)) return fail(404, "Sticker not found");
  // Files are kept: stickers already sent in chats keep rendering.
  const next = structuredClone(cur);
  next.stickers = next.stickers.filter((s) => s.id !== stickerId);
  if (next.cover === stickerId) next.cover = next.stickers[0]?.id ?? "";
  if (next.stickers.length === 0) next.published = false;
  await svc.repo.savePack(next, by);
  await svc.reload();
  return { ok: true, pack: next };
}
