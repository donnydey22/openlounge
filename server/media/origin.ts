// Media origin for the self-hosted media cache (contract: /workspace/media/CACHE_CONTRACT.md).
//   GET|HEAD|OPTIONS /media/<id>/v<rev>/<file>?exp=&p=&u=&t=   (public app port, and the internal origin port)
//   GET /media/healthz
// Token = base64url(HMAC-SHA256(MEDIA_SIGNING_SECRET, `${pathPrefix}|${exp}|${uid}`)); pathPrefix = /media/<id>/v<rev>/
// so one token covers a whole video directory (master + renditions + init + segments + poster).
// HLS playlists stay relative on disk; the serving edge appends the client's token query to every URI
// (this origin on the public port; the cache service when MEDIA_CDN_BASE points at it — the internal port returns raw).
import { applyValidators, notModifiedHeaders } from "./conditional";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import zlib from "node:zlib";
import { createHmac, timingSafeEqual } from "node:crypto";
import { log } from "../log";
import { MEDIA_CDN_BASE, MEDIA_INTERNAL_PORT } from "./config";

export const PATH_RE = /^\/media\/([A-Za-z0-9_-]{8,64})\/v(\d{1,6})\/([A-Za-z0-9._/-]{1,80})$/;
export const isMediaOriginPath = (p: string) => p.startsWith("/media/");

let secret: Buffer | null = null;
/** MEDIA_SIGNING_SECRET (shared with the cache service) or the media service's stable on-volume secret */
export function setFallbackSecret(b: Buffer) {
  secret = process.env.MEDIA_SIGNING_SECRET ? Buffer.from(process.env.MEDIA_SIGNING_SECRET) : b;
}
const key = () => secret ?? Buffer.from(process.env.MEDIA_SIGNING_SECRET || "dev-only-media-secret");

export function token(prefix: string, exp: number, uid: string) {
  return createHmac("sha256", key()).update(`${prefix}|${exp}|${uid}`).digest("base64url");
}

/** Build a signed media URL. `origin` forces the app origin (timer / view-once media never go through the cache). */
export function signedUrl(id: string, rev: number, file: string, uid: string, exp: number, opts: { origin?: boolean; dl?: boolean } = {}) {
  const prefix = `/media/${id}/v${rev}/`;
  const base = opts.origin ? "" : MEDIA_CDN_BASE;
  return `${base}${prefix}${file}?exp=${exp}&p=${encodeURIComponent(prefix)}&u=${encodeURIComponent(uid)}&t=${token(prefix, exp, uid)}${opts.dl ? "&dl=1" : ""}`;
}

export function verify(pathname: string, q: URLSearchParams, now = Date.now()): { ok: true; uid: string } | { ok: false } {
  const exp = Number(q.get("exp"));
  const prefix = q.get("p") ?? "";
  const uid = q.get("u") ?? "";
  const t = q.get("t") ?? "";
  if (!t || !uid || !prefix.startsWith("/media/") || !prefix.endsWith("/") || !pathname.startsWith(prefix)) return { ok: false };
  if (!Number.isFinite(exp) || exp * 1000 < now) return { ok: false };
  const want = token(prefix, exp, uid);
  if (t.length !== want.length || !timingSafeEqual(Buffer.from(t), Buffer.from(want))) return { ok: false };
  return { ok: true, uid };
}

/** Append the client's token query to every URI in a playlist (contract §3). */
export function rewritePlaylist(text: string, clientQuery: string) {
  if (!clientQuery) return text;
  return text
    .split("\n")
    .map((l) => {
      if (!l || l.startsWith("#")) return l.replace(/URI="([^"?]+)"/g, (_m, u) => `URI="${u}?${clientQuery}"`);
      return l.includes("?") ? l : `${l}?${clientQuery}`;
    })
    .join("\n");
}

/** What the media service resolves for a verified request. */
export interface OriginFile {
  file: string;
  mime: string;
  cache: string;
  playlist?: boolean;
  /** Content-Disposition */
  disposition?: string;
}
export type OriginLookup = (uid: string, id: string, rev: number, rest: string) => OriginFile | { status: 404 | 403 };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  "Timing-Allow-Origin": "*",
};
const SECURITY = {
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
};

let lookup: OriginLookup | null = null;
let health: () => Record<string, unknown> = () => ({});
export function configureOrigin(fn: OriginLookup, healthFn: () => Record<string, unknown>) {
  lookup = fn;
  health = healthFn;
}

function fail(res: ServerResponse, code: number) {
  res.writeHead(code, { "Content-Type": "text/plain", "Cache-Control": "no-store", ...CORS }).end(code === 404 ? "Not found" : code === 403 ? "Link expired" : "Error");
}

export async function handleMediaOrigin(req: IncomingMessage, res: ServerResponse, opts: { internal: boolean }) {
  const [pathname, qs = ""] = (req.url ?? "").split("?");
  if (pathname === "/media/healthz") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ ok: true, ...health() }));
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...CORS, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Range", "Access-Control-Max-Age": "86400" }).end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405);
  const m = PATH_RE.exec(pathname);
  if (!m || m[3].includes("..") || !lookup) return fail(res, 404);
  const q = new URLSearchParams(qs);
  const v = verify(pathname, q);
  if (!v.ok) return fail(res, 403);
  const f = lookup(v.uid, m[1], Number(m[2]), m[3]);
  if ("status" in f) return fail(res, f.status);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(f.file);
  } catch {
    return fail(res, 404);
  }
  const base: Record<string, string> = { "Content-Type": f.mime, "Cache-Control": f.cache, ...CORS, ...SECURITY };
  if (f.disposition) base["Content-Disposition"] = f.disposition;
  if (f.cache === "no-store") base.Pragma = "no-cache";

  if (f.playlist) {
    let body = fs.readFileSync(f.file, "utf8");
    if (!opts.internal) {
      const clientQuery = ["exp", "p", "u", "t"].map((k) => `${k}=${encodeURIComponent(q.get(k) ?? "")}`).join("&");
      body = rewritePlaylist(body, clientQuery);
      base.Vary = "Accept-Encoding";
      if (/\bgzip\b/.test(String(req.headers["accept-encoding"] ?? "")) && body.length > 512) {
        const gz = zlib.gzipSync(body);
        res.writeHead(200, { ...base, "Content-Encoding": "gzip", "Content-Length": String(gz.length) });
        return void res.end(req.method === "HEAD" ? undefined : gz);
      }
    }
    const buf = Buffer.from(body);
    res.writeHead(200, { ...base, "Content-Length": String(buf.length) });
    return void res.end(req.method === "HEAD" ? undefined : buf);
  }

  base["Accept-Ranges"] = "bytes";
  if (f.cache !== "no-store" && applyValidators(req, stat, base) && !req.headers.range) {
    res.writeHead(304, notModifiedHeaders(base)).end();
    return;
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
    } else start = Math.max(0, stat.size - Number(range[2]));
    if (start > end || start >= stat.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Cache-Control": "no-store", ...CORS }).end();
      return;
    }
    status = 206;
    base["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  }
  base["Content-Length"] = String(end - start + 1);
  res.writeHead(status, base);
  if (req.method === "HEAD") return void res.end();
  const stream = fs.createReadStream(f.file, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

/** Origin-only listener for the cache service (Railway private networking, IPv6). Serves /media/* only. */
let internal: http.Server | null = null;
export function startInternalOrigin() {
  if (internal || !MEDIA_INTERNAL_PORT || process.env.NODE_ENV === "test") return;
  internal = http.createServer((req, res) => {
    if (!(req.url ?? "").startsWith("/media/")) return fail(res, 404);
    void handleMediaOrigin(req, res, { internal: true }).catch((err) => {
      log.error("media origin failed", { err });
      if (!res.headersSent) fail(res, 500);
    });
  });
  internal.requestTimeout = 60_000;
  internal.on("error", (err) => log.warn("media internal origin not listening", { port: MEDIA_INTERNAL_PORT, err: String(err) }));
  internal.listen(MEDIA_INTERNAL_PORT, "::", () => log.info("media internal origin", { port: MEDIA_INTERNAL_PORT }));
  internal.unref();
}

// ---------- purge hook (origin → cache), no-op unless MEDIA_CACHE_PURGE_URL is set ----------
export function purgeCache(prefixes: string[]) {
  const url = process.env.MEDIA_CACHE_PURGE_URL;
  if (!url || !prefixes.length) return;
  const send = async (attempt: number): Promise<void> => {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.MEDIA_CACHE_PURGE_SECRET ?? ""}` },
        body: JSON.stringify({ prefixes }),
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (err) {
      if (attempt === 0) return void setTimeout(() => void send(1), 5000).unref();
      log.warn("media cache purge failed", { prefixes, err: String(err) });
    }
  };
  void send(0);
}
