// Contract-conformant stand-in for the origin's internal media port (CACHE_CONTRACT.md v1 §3–5), for cache tests.
// Serves test/.fixture/src as /media/<ID>/v1/<file>; validates tokens; counts requests; Range; raw playlists.
// Control (separate port): GET /stats, POST /reset, POST /mode?processing=0|1&fail=0|1
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.MEDIA_SIGNING_SECRET;
const PORT = Number(process.env.ORIGIN_PORT || 18081), CTL = Number(process.env.ORIGIN_CTL_PORT || 18082);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), ".fixture/src");
const NOSTORE_ID = "f".repeat(32); // stands in for a view-once/timer item → no-store
const GONE = new Set();
let counts = {}, total = 0, processing = false, fail = false;

const types = { ".m4s": "video/iso.segment", ".mp4": "video/mp4", ".webp": "image/webp", ".m3u8": "application/vnd.apple.mpegurl", ".m4a": "audio/mp4" };
const common = { "Access-Control-Allow-Origin": "*", "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges", "Timing-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Accept-Ranges": "bytes" };

function valid(pathname, q) {
  const exp = q.get("exp"), p = q.get("p"), u = q.get("u"), t = q.get("t");
  if (!exp || !p || !u || !t || !pathname.startsWith(p) || Number(exp) * 1000 <= Date.now()) return false;
  const want = Buffer.from(createHmac("sha256", SECRET).update(`${p}|${exp}|${u}`).digest("base64url"));
  const got = Buffer.from(t);
  return want.length === got.length && timingSafeEqual(want, got);
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/media/healthz") { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); return res.end('{"ok":true,"ffmpeg":true,"queue":0}'); }
  total++; counts[url.pathname] = (counts[url.pathname] || 0) + 1;
  counts["range:" + url.pathname] = (counts["range:" + url.pathname] || []).concat(req.headers.range || "none").slice(-50);
  if (fail) { res.writeHead(503, { "Cache-Control": "no-store" }); return res.end("down"); }
  const m = /^\/media\/([0-9a-f]{32})\/v(\d+)\/(.+)$/.exec(url.pathname);
  if (!m) { res.writeHead(404, { "Cache-Control": "no-store" }); return res.end(); }
  if (!valid(url.pathname, url.searchParams)) { res.writeHead(403, { "Cache-Control": "no-store", "Content-Type": "text/plain" }); return res.end("Link expired"); }
  if (GONE.has(m[1])) { res.writeHead(404, { "Cache-Control": "no-store" }); return res.end("Not found"); }
  const file = path.join(ROOT, m[3]);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404, { "Cache-Control": "no-store" }); return res.end(); }
  const ext = path.extname(file);
  let cc = "public, max-age=31536000, immutable";
  let body = null;
  if (ext === ".m3u8") {
    body = fs.readFileSync(file, "utf8");
    const master = m[3].endsWith("master.m3u8");
    if (processing) {
      cc = master ? "public, max-age=10, stale-while-revalidate=10" : "public, max-age=5, stale-while-revalidate=5";
      if (!master) body = body.replace("#EXT-X-ENDLIST\n", "") + `#EXT-X-PROGRAM-DATE-TIME:${new Date().toISOString()}\n`; // changes each fetch
    }
  }
  if (m[1] === NOSTORE_ID) cc = "no-store";
  const size = body !== null ? Buffer.byteLength(body) : fs.statSync(file).size;
  const h = { ...common, "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": cc };
  const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (r && body === null) {
    let start = r[1] ? Number(r[1]) : Math.max(0, size - Number(r[2]));
    let end = r[1] && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
    if (start >= size) { res.writeHead(416, { ...h, "Content-Range": `bytes */${size}`, "Cache-Control": "no-store" }); return res.end(); }
    res.writeHead(206, { ...h, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...h, "Content-Length": size });
  if (req.method === "HEAD") return res.end();
  if (body !== null) return res.end(body);
  fs.createReadStream(file).pipe(res);
}).listen(PORT, "::", () => console.log(`mock origin on [::]:${PORT}`));

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/stats") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ total, counts })); }
  if (url.pathname === "/reset") { counts = {}; total = 0; }
  if (url.pathname === "/mode") {
    if (url.searchParams.has("processing")) processing = url.searchParams.get("processing") === "1";
    if (url.searchParams.has("fail")) fail = url.searchParams.get("fail") === "1";
    if (url.searchParams.has("gone")) GONE.add(url.searchParams.get("gone"));
  }
  res.writeHead(200).end(JSON.stringify({ processing, fail }));
}).listen(CTL, "127.0.0.1");
