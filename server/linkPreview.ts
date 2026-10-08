// Link preview cards for chat links (Telegram-style): GET /lp/preview?url=…  (signed-in users only)
// and the proxied thumbnails GET /lp/img/<key>.jpg (route handlers in src/app/lp).
//
// SSRF-hardened: http(s) only, ports 80/443, no user:pass@, every hop's DNS answer is checked against
// private/loopback/link-local/CGNAT/multicast/reserved ranges and the socket is PINNED to the checked address
// (no DNS-rebinding window), manual redirects (max 3, each re-checked), 5 s timeouts, 512 KB HTML / 6 MB image caps,
// text/html and image/* only. Images are re-encoded by sharp (strips metadata, kills SVG/polyglots) to a 400 px
// JPEG + a tiny blurred placeholder (data: URI) so the client can reserve space and fade in without layout shift.
// The image endpoint only serves bytes this server produced for a preview: it is not an open proxy.
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

export type LinkPreview = {
  url: string;
  site: string;
  title: string;
  description: string;
  image: { src: string; w: number; h: number; blur: string } | null;
  /** YouTube / Vimeo / og:video pages get a play badge on the thumbnail */
  video: boolean;
};

const UA = "Mozilla/5.0 (compatible; OpenLoungeBot/1.0; +https://openlounge.app)";
const HTML_MAX = 512 * 1024;
const IMG_MAX = 6 * 1024 * 1024;
const TIMEOUT = 5000;
const META_TTL = 6 * 3600_000;
const NEG_TTL = 15 * 60_000;

// ---------- address checks ----------
function v4ToInt(ip: string) {
  return ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCK: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4], ["255.255.255.255", 32],
];
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return !V4_BLOCK.some(([base, bits]) => (n & (bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0)) >>> 0 === v4ToInt(base));
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPublicAddress(mapped[1]);
    if (s === "::" || s === "::1") return false;
    if (/^(fc|fd)/.test(s)) return false; // unique local
    if (/^fe[89ab]/.test(s)) return false; // link-local
    if (/^ff/.test(s)) return false; // multicast
    if (/^2001:db8/.test(s) || /^2001:0?:/.test(s) || /^64:ff9b:/.test(s) || /^2002:/.test(s) || /^100::/.test(s)) return false; // doc, teredo, nat64, 6to4, discard
    return true;
  }
  return false;
}

function checkUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  const h = u.hostname.replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".railway.internal")) return null;
  if (net.isIP(h) && !isPublicAddress(h)) return null;
  return u;
}

async function resolvePublic(host: string): Promise<{ address: string; family: number }> {
  const h = host.replace(/^\[|\]$/g, "");
  if (net.isIP(h)) {
    if (!isPublicAddress(h)) throw new Error("blocked address");
    return { address: h, family: net.isIPv6(h) ? 6 : 4 };
  }
  const all = await dns.promises.lookup(h, { all: true, verbatim: true });
  if (!all.length || all.some((a) => !isPublicAddress(a.address))) throw new Error("blocked address");
  return all[0];
}

type Fetched = { status: number; type: string; body: Buffer; url: URL };

async function fetchPinned(start: URL, accept: string, max: number, hops = 3): Promise<Fetched> {
  let url = start;
  for (let i = 0; i <= hops; i++) {
    const addr = await resolvePublic(url.hostname);
    const mod = url.protocol === "https:" ? https : http;
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = mod.request(
        url,
        {
          method: "GET",
          headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en", "Accept-Encoding": "identity" },
          timeout: TIMEOUT,
          // pin the socket to the address we just validated (no second DNS lookup → no rebinding)
          lookup: (_h: string, opts: unknown, cb: (...a: unknown[]) => void) => {
            if ((opts as { all?: boolean })?.all) cb(null, [{ address: addr.address, family: addr.family }]);
            else cb(null, addr.address, addr.family);
          },
          ...(url.protocol === "https:" ? { servername: net.isIP(url.hostname) ? undefined : url.hostname } : {}),
        } as https.RequestOptions,
        resolve,
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end();
    });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      const next = checkUrl(new URL(res.headers.location, url).href);
      if (!next) throw new Error("blocked redirect");
      url = next;
      continue;
    }
    const type = String(res.headers["content-type"] ?? "").toLowerCase();
    const declared = Number(res.headers["content-length"] ?? 0);
    if (declared > max) {
      res.destroy();
      throw new Error("too large");
    }
    const chunks: Buffer[] = [];
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => res.destroy(new Error("timeout")), TIMEOUT);
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > max) {
          // HTML: the <head> is all we need, keep what we have; images: refuse
          if (accept.startsWith("text/html")) {
            chunks.push(c.subarray(0, Math.max(0, c.length - (size - max))));
            res.destroy();
            clearTimeout(timer);
            resolve();
            return;
          }
          res.destroy(new Error("too large"));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => {
        clearTimeout(timer);
        resolve();
      });
      res.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      res.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return { status, type, body: Buffer.concat(chunks), url };
  }
  throw new Error("too many redirects");
}

// ---------- HTML metadata ----------
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
function decodeEntities(s: string) {
  return s
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => safeCp(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d) => safeCp(Number(d)))
    .replace(/&([a-z0-9#]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
const safeCp = (n: number) => (n > 0 && n < 0x110000 && !(n >= 0xd800 && n < 0xe000) ? String.fromCodePoint(n) : "");
const clean = (s: string | undefined, max: number) => {
  const t = decodeEntities(String(s ?? "")).replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
};

export function parseMeta(html: string): { title: string; description: string; site: string; image: string; video: boolean } {
  const head = html.slice(0, HTML_MAX).split(/<\/head>/i)[0];
  const meta: Record<string, string> = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (n: string) => new RegExp(`\\b${n}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    const key = attr("property") ?? attr("name");
    const val = attr("content");
    if (!key || !val) continue;
    const k = (key[2] ?? key[3] ?? key[4] ?? "").toLowerCase();
    if (!(k in meta)) meta[k] = val[2] ?? val[3] ?? val[4] ?? "";
  }
  const titleTag = /<title[^>]*>([\s\S]{0,600}?)<\/title>/i.exec(head)?.[1];
  return {
    title: clean(meta["og:title"] ?? meta["twitter:title"] ?? titleTag, 140),
    description: clean(meta["og:description"] ?? meta["twitter:description"] ?? meta["description"], 240),
    site: clean(meta["og:site_name"] ?? meta["application-name"], 60),
    video: /^video/.test(meta["og:type"] ?? "") || !!(meta["og:video"] || meta["og:video:url"] || meta["og:video:secure_url"] || meta["twitter:player"]),
    image: (meta["og:image:secure_url"] ?? meta["og:image"] ?? meta["og:image:url"] ?? meta["twitter:image"] ?? meta["twitter:image:src"] ?? "").trim(),
  };
}

// ---------- caches ----------
class Lru<V> {
  private m = new Map<string, { v: V; exp: number; size: number }>();
  private bytes = 0;
  constructor(private maxEntries: number, private maxBytes = Infinity) {}
  get(k: string): V | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.delete(k);
      return undefined;
    }
    this.m.delete(k);
    this.m.set(k, e);
    return e.v;
  }
  set(k: string, v: V, ttl: number, size = 0) {
    this.delete(k);
    this.m.set(k, { v, exp: Date.now() + ttl, size });
    this.bytes += size;
    while (this.m.size > this.maxEntries || this.bytes > this.maxBytes) {
      const first = this.m.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.delete(first);
    }
  }
  delete(k: string) {
    const e = this.m.get(k);
    if (e) {
      this.bytes -= e.size;
      this.m.delete(k);
    }
  }
}
// Route handlers may be bundled separately by Next: keep ONE cache per process on globalThis.
type Shared = { metaCache: Lru<LinkPreview | null>; imgCache: Lru<Buffer>; inflight: Map<string, Promise<LinkPreview | null>>; perUser: Map<string, { n: number; reset: number }> };
const G = globalThis as unknown as { __olLinkPreview?: Shared };
const shared: Shared = (G.__olLinkPreview ??= { metaCache: new Lru<LinkPreview | null>(2000), imgCache: new Lru<Buffer>(600, 48 * 1024 * 1024), inflight: new Map(), perUser: new Map() });
const { metaCache, imgCache, inflight } = shared;

type SharpFn = (input: Buffer, opts?: Record<string, unknown>) => {
  rotate(): ReturnType<SharpFn>;
  resize(w: number, h?: number, o?: Record<string, unknown>): ReturnType<SharpFn>;
  webp(o?: Record<string, unknown>): ReturnType<SharpFn>;
  jpeg(o?: Record<string, unknown>): ReturnType<SharpFn>;
  flatten(o?: Record<string, unknown>): ReturnType<SharpFn>;
  png(): ReturnType<SharpFn>;
  blur(s?: number): ReturnType<SharpFn>;
  toBuffer(o: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }>;
  metadata(): Promise<{ width?: number; height?: number; format?: string; pages?: number }>;
};
let sharpP: Promise<SharpFn | null> | null = null;
const loadSharp = () => (sharpP ??= import("sharp").then((m) => (m.default ?? m) as unknown as SharpFn).catch(() => null));

async function thumb(imageUrl: string): Promise<LinkPreview["image"]> {
  const u = checkUrl(imageUrl);
  if (!u) return null;
  const sharp = await loadSharp();
  if (!sharp) return null;
  const f = await fetchPinned(u, "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8", IMG_MAX).catch(() => null);
  if (!f || f.status !== 200 || !/^image\/(png|jpe?g|webp|gif|avif)/.test(f.type)) return null;
  try {
    const meta = await sharp(f.body, { limitInputPixels: 40_000_000, failOn: "error" }).metadata();
    if (!meta.width || !meta.height || meta.width < 40 || meta.height < 40) return null;
    const full = await sharp(f.body, { limitInputPixels: 40_000_000, pages: 1 }).rotate().resize(720, 720, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#18181b" }).jpeg({ quality: 74, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    const tiny = await sharp(f.body, { limitInputPixels: 40_000_000, pages: 1 }).rotate().resize(16, 16, { fit: "inside" }).flatten({ background: "#18181b" }).blur(1).jpeg({ quality: 40 }).toBuffer({ resolveWithObject: true });
    const key = crypto.createHash("sha256").update(u.href).digest("base64url").slice(0, 32);
    imgCache.set(key, full.data, 24 * 3600_000, full.data.length);
    return { src: `/lp/img/${key}.jpg`, w: full.info.width, h: full.info.height, blur: `data:image/jpeg;base64,${tiny.data.toString("base64")}` };
  } catch {
    return null;
  }
}

export async function getPreview(raw: string): Promise<LinkPreview | null> {
  const u = checkUrl(raw);
  if (!u) return null;
  u.hash = "";
  const key = u.href;
  const hit = metaCache.get(key);
  if (hit !== undefined) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    try {
      const f = await fetchPinned(u, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1", HTML_MAX);
      if (f.status !== 200 || !/text\/html|application\/xhtml/.test(f.type)) throw new Error("not html");
      const charset = /charset=([\w-]+)/.exec(f.type)?.[1]?.toLowerCase();
      let html: string;
      try {
        html = new TextDecoder(charset && charset !== "utf8" ? charset : "utf-8").decode(f.body);
      } catch {
        html = f.body.toString("utf8");
      }
      const m = parseMeta(html);
      const site = m.site || f.url.hostname.replace(/^www\./, "");
      if (!m.title && !m.description && !m.image) throw new Error("no metadata");
      let image: LinkPreview["image"] = null;
      if (m.image) {
        try {
          image = await thumb(new URL(m.image, f.url).href);
        } catch {
          image = null;
        }
      }
      const video = m.video || /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|tiktok\.com)$/.test(f.url.hostname);
      const out: LinkPreview = { url: key, site, title: m.title || site, description: m.description, image, video };
      metaCache.set(key, out, META_TTL);
      return out;
    } catch {
      metaCache.set(key, null, NEG_TTL);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// ---------- helpers for the route handlers (src/app/lp/*) ----------
export function allowUser(userId: string) {
  const now = Date.now();
  const m = shared.perUser;
  const e = m.get(userId);
  if (!e || e.reset < now) {
    m.set(userId, { n: 1, reset: now + 60_000 });
    if (m.size > 20_000) m.clear();
    return true;
  }
  e.n += 1;
  return e.n <= 60;
}

/** Thumbnail bytes this server produced for a preview (never fetches anything itself). */
export function cachedThumb(key: string): Buffer | undefined {
  return /^[A-Za-z0-9_-]{16,64}$/.test(key) ? imgCache.get(key) : undefined;
}
