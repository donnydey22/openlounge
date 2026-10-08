// Open Lounge media cache: njs side.
// Implements the cache half of /workspace/media/CACHE_CONTRACT.md (v1):
//   verify()      signed-link check on EVERY /media request (hits included), §3
//   m3u8Headers() / m3u8Body()  per-viewer playlist rewrite of the token-free cached copy, §3 "HLS"
//   purge()       POST /_purge {"prefixes":["/media/<id>/"]} from the origin, §6
//   readyz()      deploy gate, same shape as the app's /readyz
// Secrets come from process.env (nginx `env` directive); they are never written to disk or logged.
import fs from "fs";
import crypto from "crypto";

const CACHE_DIR = (process.env.DATA_DIR || "/data") + "/cache";
const META_DIR = (process.env.DATA_DIR || "/data") + "/cache-meta";
const TOMB_DIR = META_DIR + "/tomb";

const PREFIX_RE = /^\/media\/([0-9a-f]{32})\/v([1-9][0-9]{0,8})\/$/;
const PATH_RE = /^\/media\/([0-9a-f]{32})\/v([1-9][0-9]{0,8})\/[A-Za-z0-9_][A-Za-z0-9_.\-]*(\/[A-Za-z0-9_][A-Za-z0-9_.\-]*){0,2}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32-byte HMAC, base64url, no padding
const SIGN_KEYS = ["exp", "p", "u", "t"];

function eq(a, b) {
  // constant-time compare of two ASCII strings
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function one(v) {
  return typeof v === "string" ? v : undefined; // duplicated keys arrive as arrays → reject
}

function tombstoned(id, rev) {
  const names = [id, id + "_v" + rev];
  for (let i = 0; i < names.length; i++) {
    try { fs.accessSync(TOMB_DIR + "/" + names[i]); return true; } catch (e) { /* not purged */ }
  }
  return false;
}

/** js_set $media_auth: "ok" | "gone" (purged: bypass cache, origin decides) | a rejection reason. */
function verify(r) {
  const secret = process.env.MEDIA_SIGNING_SECRET || "";
  if (secret.length < 16) return "nosecret";
  const uri = r.variables.uri; // decoded + normalised ('..' resolved) — the same string the cache key uses
  const m = PATH_RE.exec(uri);
  if (!m) return "path";
  const a = r.args;
  const exp = one(a.exp), p = one(a.p), u = one(a.u), t = one(a.t);
  if (!exp || !p || !u || !t) return "missing";
  if (!/^[0-9]{1,12}$/.test(exp)) return "exp";
  if (!PREFIX_RE.test(p) || uri.indexOf(p) !== 0) return "prefix";
  if (u.length > 128) return "uid";
  if (!TOKEN_RE.test(t)) return "token";
  if (Number(exp) * 1000 <= Date.now()) return "expired";
  const want = crypto.createHmac("sha256", secret).update(p + "|" + exp + "|" + u).digest("base64url");
  if (!eq(want, t)) return "token";
  if (tombstoned(m[1], m[2])) return "gone";
  return "ok";
}

/** js_set $media_bypass: "1" when the item was purged (never serve or store a cached copy). */
function bypass(r) {
  return r.variables.media_auth === "gone" ? "1" : "";
}

/** The client's own token query, exactly as received (order + encoding), only the four signing keys. */
function clientQuery(r) {
  const raw = r.variables.args || "";
  return raw.split("&").filter((kv) => SIGN_KEYS.indexOf(kv.split("=")[0]) !== -1).join("&");
}

function rewritePlaylist(body, q) {
  if (!q) return body;
  return body.split("\n").map((line) => {
    const l = line.replace(/\r$/, "");
    if (!l.trim()) return line;
    if (l.charAt(0) === "#") {
      return line.replace(/URI="([^"]*)"/g, (_, u) => 'URI="' + u + (u.indexOf("?") === -1 ? "?" : "&") + q + '"');
    }
    return l + (l.indexOf("?") === -1 ? "?" : "&") + q + (line.length > l.length ? "\r" : "");
  }).join("\n");
}

let playlistChunks = [];

function m3u8Headers(r) {
  if (r.status === 200) delete r.headersOut["Content-Length"]; // body length changes per viewer
}

function m3u8Body(r, data, flags) {
  if (r.status !== 200) { r.sendBuffer(data, flags); return; }
  playlistChunks.push(data); // module scope is per request in njs (one VM clone per request)
  if (flags.last) {
    r.sendBuffer(rewritePlaylist(playlistChunks.join(""), clientQuery(r)), { last: true });
    playlistChunks = [];
  }
}

// ---------------------------------------------------------------- purge (origin → cache, §6)
/** The cache key stored in an nginx cache file header ("\nKEY: <key>\n" within the first KiB), or "". */
function readKey(path) {
  let fd;
  try {
    fd = fs.openSync(path, "r");
    const buf = Buffer.alloc(1024);
    const got = fs.readSync(fd, buf, 0, 1024, 0);
    const head = buf.slice(0, got);
    const i = head.indexOf("\nKEY: ");
    if (i === -1) return "";
    const j = head.indexOf("\n", i + 6);
    return head.slice(i + 6, j === -1 ? got : j).toString("utf8");
  } catch (e) {
    return "";
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  }
}

function walk(dir, depth, fn) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  for (let k = 0; k < names.length; k++) {
    const p = dir + "/" + names[k];
    if (depth > 0) walk(p, depth - 1, fn);
    else fn(p);
  }
}

function purgeKeys(prefixes) {
  let scanned = 0, removed = 0;
  walk(CACHE_DIR, 2, (file) => { // levels=1:2 → CACHE_DIR/x/yy/<md5>
    scanned++;
    const key = readKey(file);
    if (!key) return;
    for (let k = 0; k < prefixes.length; k++) {
      if (key.indexOf(prefixes[k]) === 0) {
        try { fs.unlinkSync(file); removed++; } catch (e) { /* raced with the cache manager */ }
        return;
      }
    }
  });
  return { scanned, removed };
}

function mkdirp(path) {
  let cur = "";
  const parts = path.split("/").filter(Boolean);
  for (let k = 0; k < parts.length; k++) {
    cur += "/" + parts[k];
    try { fs.mkdirSync(cur); } catch (e) { /* exists */ }
  }
}

function purge(r) {
  const secret = process.env.MEDIA_CACHE_PURGE_SECRET || "";
  const auth = (r.headersIn.Authorization || "").replace(/^Bearer\s+/i, "");
  if (r.method !== "POST") return r.return(405);
  if (secret.length < 16 || !eq(auth, secret)) return r.return(401);
  let prefixes;
  try { prefixes = JSON.parse(r.requestText || "{}").prefixes; } catch (e) { return r.return(400); }
  if (!Array.isArray(prefixes) || !prefixes.length || prefixes.length > 100) return r.return(400);
  const tombs = [];
  for (let k = 0; k < prefixes.length; k++) {
    const pre = prefixes[k];
    const m = typeof pre === "string" && /^\/media\/([0-9a-f]{32})\/(?:v([1-9][0-9]{0,8})\/)?$/.exec(pre);
    if (!m) return r.return(400);
    tombs.push(m[2] ? m[1] + "_v" + m[2] : m[1]);
  }
  mkdirp(TOMB_DIR);
  for (let k = 0; k < tombs.length; k++) fs.writeFileSync(TOMB_DIR + "/" + tombs[k], String(Date.now()));
  const res = purgeKeys(prefixes);
  r.warn("media-cache purge " + JSON.stringify({ prefixes: prefixes.length, scanned: res.scanned, removed: res.removed }));
  r.headersOut["Cache-Control"] = "no-store";
  return r.return(204);
}

// ---------------------------------------------------------------- readiness
async function readyz(r) {
  const out = { ok: true, signing: (process.env.MEDIA_SIGNING_SECRET || "").length >= 16, purge: (process.env.MEDIA_CACHE_PURGE_SECRET || "").length >= 16, cacheWritable: false, origin: { ok: false } };
  try {
    mkdirp(META_DIR);
    fs.writeFileSync(META_DIR + "/.probe", String(Date.now())); // not inside the cache dir (the loader would complain)
    out.cacheWritable = true;
  } catch (e) { /* not writable */ }
  try {
    const s = await r.subrequest("/_origin_health");
    out.origin = { ok: s.status === 200, status: s.status };
  } catch (e) { out.origin = { ok: false, error: "unreachable" }; }
  out.ok = out.signing && out.cacheWritable && (out.origin.ok || process.env.READYZ_REQUIRE_ORIGIN !== "1");
  r.headersOut["Content-Type"] = "application/json";
  r.headersOut["Cache-Control"] = "no-store";
  r.return(out.ok ? 200 : 503, JSON.stringify(out));
}

export default { verify, bypass, m3u8Headers, m3u8Body, purge, readyz, _rewritePlaylist: rewritePlaylist };
