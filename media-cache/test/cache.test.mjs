// Media cache behaviour tests against a running cache + mock origin (test/run-local.sh), or any cache via env:
//   CACHE=http://127.0.0.1:18080 PURGE=http://127.0.0.1:18083/_purge CTL=http://127.0.0.1:18082 node test/cache.test.mjs
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CACHE = process.env.CACHE || "http://127.0.0.1:18080";
const PURGE = process.env.PURGE || "http://127.0.0.1:18083/_purge";
const CTL = process.env.CTL || "http://127.0.0.1:18082";
const SECRET = process.env.MEDIA_SIGNING_SECRET, PSECRET = process.env.MEDIA_CACHE_PURGE_SECRET;
const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), ".fixture/src");
const results = [];
let failed = 0;
const ok = (name, cond, detail = "") => { results.push({ name, pass: !!cond, detail }); if (!cond) failed++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => randomBytes(16).toString("hex");

function q(id, { rev = 1, uid = "u_" + randomBytes(3).toString("hex"), ttl = 900, prefix } = {}) {
  const p = prefix ?? `/media/${id}/v${rev}/`;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const t = createHmac("sha256", SECRET).update(`${p}|${exp}|${uid}`).digest("base64url");
  return `exp=${exp}&p=${encodeURIComponent(p)}&u=${encodeURIComponent(uid)}&t=${t}`;
}
const get = (u, opt = {}) => fetch(CACHE + u, { redirect: "manual", ...opt });
const stats = async () => (await fetch(CTL + "/stats")).json();
const mode = (s) => fetch(CTL + "/mode?" + s);
const originCount = async (p) => (await stats()).counts[p] || 0;
const xc = (r) => r.headers.get("x-cache-status");

async function main() {
  await fetch(CTL + "/reset");
  // ---------- hit / miss, key excludes the token
  let id = newId(), seg = `/media/${id}/v1/hls/r360/seg_00001.m4s`;
  let r1 = await get(`${seg}?${q(id)}`); const b1 = Buffer.from(await r1.arrayBuffer());
  let r2 = await get(`${seg}?${q(id, { uid: "someone_else" })}`); await r2.arrayBuffer();
  ok("segment: first request MISS, second (different viewer + token) HIT", xc(r1) === "MISS" && xc(r2) === "HIT", `${xc(r1)} → ${xc(r2)}`);
  ok("segment: bytes identical to origin file", b1.equals(fs.readFileSync(path.join(FIX, "hls/r360/seg_00001.m4s"))));
  ok("segment: origin asked once for 2 viewers", (await originCount(seg)) === 1, `origin=${await originCount(seg)}`);
  ok("segment: origin Cache-Control kept (1 year immutable)", r2.headers.get("cache-control") === "public, max-age=31536000, immutable", r2.headers.get("cache-control"));
  ok("segment: CORS/CORP headers kept", r2.headers.get("access-control-allow-origin") === "*" && r2.headers.get("cross-origin-resource-policy") === "cross-origin");

  // ---------- signed links
  const exp = await get(`${seg}?${q(id, { ttl: -5 })}`);
  ok("expired token on a cached object → 403 (validated on HIT)", exp.status === 403 && xc(exp) === "DENIED", `${exp.status} ${xc(exp)}`);
  ok("403 carries Cache-Control: no-store", exp.headers.get("cache-control") === "no-store");
  const good = q(id);
  const tam = good.replace(/t=([A-Za-z0-9_-])/, (_, c) => "t=" + (c === "A" ? "B" : "A"));
  ok("tampered token → 403", (await get(`${seg}?${tam}`)).status === 403);
  const tamExp = good.replace(/exp=(\d+)/, (_, e) => "exp=" + (Number(e) + 3600));
  ok("tampered exp (extended) → 403", (await get(`${seg}?${tamExp}`)).status === 403);
  ok("tampered uid → 403", (await get(`${seg}?${good.replace(/u=[^&]+/, "u=attacker")}`)).status === 403);
  const other = newId();
  ok("wrong prefix (token for another media id) → 403", (await get(`${seg}?${q(other)}`)).status === 403);
  ok("wrong prefix (token for v2 used on v1) → 403", (await get(`${seg}?${q(id, { rev: 2 })}`)).status === 403);
  ok("over-broad prefix '/media/' even with a valid HMAC → 403", (await get(`${seg}?${q(id, { prefix: "/media/" })}`)).status === 403);
  ok("no token → 403", (await get(seg)).status === 403);
  ok("duplicated token params → 403", (await get(`${seg}?${good}&t=xxx`)).status === 403);
  const trav = await get(`/media/${id}/v1/hls/../../../${other}/v1/hls/r360/seg_00001.m4s?${q(id)}`);
  ok("path traversal to another id → 403", trav.status === 403, String(trav.status));
  ok("valid token still works after all rejections (HIT)", xc(await get(`${seg}?${good}`)) === "HIT");
  ok("rejections never reached the origin", (await originCount(seg)) === 1);

  // ---------- playlists: one cached token-free copy, rewritten per viewer
  id = newId();
  const master = `/media/${id}/v1/hls/master.m3u8`, idx = `/media/${id}/v1/hls/r240/index.m3u8`;
  const qa = q(id, { uid: "alice" }), qb = q(id, { uid: "bob" });
  const ma = await get(`${master}?${qa}`, { headers: { "accept-encoding": "identity" } }); const ta = await ma.text();
  const mb = await get(`${master}?${qb}`, { headers: { "accept-encoding": "identity" } }); const tb = await mb.text();
  const uriLines = (t) => t.split("\n").filter((l) => l && !l.startsWith("#"));
  ok("master: every URI carries the viewer's own token (alice)", uriLines(ta).every((l) => l.endsWith("?" + qa)) && uriLines(ta).length === 4);
  ok("master: second viewer gets their own token from the cached copy (HIT)", xc(mb) === "HIT" && uriLines(tb).every((l) => l.endsWith("?" + qb)) && !tb.includes("alice"));
  ok("master: origin asked once", (await originCount(master)) === 1);
  const ix = await (await get(`${idx}?${qa}`)).text();
  ok("rendition: #EXT-X-MAP URI rewritten", ix.includes(`#EXT-X-MAP:URI="init.mp4?${qa}"`));
  ok("rendition: segment lines rewritten", uriLines(ix).every((l) => /^seg_\d{5}\.m4s\?/.test(l) && l.endsWith(qa)));
  const gz = await get(`${master}?${qa}`, { headers: { "accept-encoding": "gzip" } });
  ok("playlists gzip at the cache with Vary: Accept-Encoding", gz.headers.get("content-encoding") === "gzip" && /accept-encoding/i.test(gz.headers.get("vary") || ""), `${gz.headers.get("content-encoding")} vary=${gz.headers.get("vary")}`);
  ok("final playlist Cache-Control long-lived", ma.headers.get("cache-control") === "public, max-age=31536000, immutable");

  // ---------- TTLs while processing
  await mode("processing=1");
  id = newId();
  const pidx = `/media/${id}/v1/hls/r240/index.m3u8`, pm = `/media/${id}/v1/hls/master.m3u8`, qp = q(id);
  const p1 = await get(`${pidx}?${qp}`); await p1.text();
  const p2 = await get(`${pidx}?${qp}`); await p2.text();
  ok("processing rendition: Cache-Control max-age=5 passed through", p1.headers.get("cache-control") === "public, max-age=5, stale-while-revalidate=5", p1.headers.get("cache-control"));
  ok("processing rendition: HIT within 5 s", xc(p2) === "HIT");
  const m1 = await get(`${pm}?${qp}`); await m1.text();
  await sleep(6000);
  const p3 = await get(`${pidx}?${qp}`); await p3.text();
  ok("processing rendition after 6 s: refreshed (served stale-while-revalidate or re-fetched)", ["UPDATING", "EXPIRED", "STALE", "REVALIDATED"].includes(xc(p3)), xc(p3));
  await sleep(300);
  ok("processing rendition: origin re-asked after TTL (2 fetches)", (await originCount(pidx)) === 2, `origin=${await originCount(pidx)}`);
  const m2 = await get(`${pm}?${qp}`); await m2.text();
  ok("processing master: still HIT at 6 s (max-age=10)", xc(m2) === "HIT", xc(m2));
  await sleep(4500);
  const m3 = await get(`${pm}?${qp}`); await m3.text();
  ok("processing master: refreshed after 10 s", xc(m3) !== "HIT", xc(m3));
  // origin down: stale copy served instead of an error
  await mode("fail=1");
  await sleep(5500);
  const p4 = await get(`${pidx}?${qp}`); const p4t = await p4.text();
  await sleep(200);
  const p5 = await get(`${pidx}?${qp}`); await p5.text();
  ok("origin down: expired playlist served from cache (no error)", p4.status === 200 && p5.status === 200 && p4t.includes("#EXTM3U"), `${p4.status}/${xc(p4)} then ${p5.status}/${xc(p5)}`);
  const never = `/media/${newId()}/v1/hls/r240/seg_00002.m4s`;
  const f1 = await get(`${never}?${q(never.split("/")[2])}`);
  await mode("fail=0");
  const f2 = await get(`${never}?${q(never.split("/")[2])}`); await f2.arrayBuffer();
  ok("origin 503 is not cached (next request after recovery is a fresh MISS → 200)", f1.status === 503 && f2.status === 200 && xc(f2) === "MISS", `${f1.status} → ${f2.status} ${xc(f2)}`);
  await mode("processing=0");

  // ---------- no-store items (timer / view-once) are never stored
  const ns = "f".repeat(32), nsp = `/media/${ns}/v1/poster.webp`;
  await (await get(`${nsp}?${q(ns)}`)).arrayBuffer(); const ns2 = await get(`${nsp}?${q(ns)}`); await ns2.arrayBuffer();
  ok("Cache-Control: no-store response never cached", xc(ns2) === "MISS" && (await originCount(nsp)) === 2, `${xc(ns2)} origin=${await originCount(nsp)}`);

  // ---------- 404 from the origin not cached
  id = newId(); await mode("gone=" + id);
  const g = `/media/${id}/v1/thumb.webp`;
  await get(`${g}?${q(id)}`); const g2 = await get(`${g}?${q(id)}`);
  ok("origin 404 not cached", g2.status === 404 && (await originCount(g)) === 2);

  // ---------- range requests
  id = newId(); seg = `/media/${id}/v1/hls/r720/seg_00002.m4s`;
  const file = fs.readFileSync(path.join(FIX, "hls/r720/seg_00002.m4s"));
  const rr1 = await get(`${seg}?${q(id)}`, { headers: { range: "bytes=100-1099" } }); const rb1 = Buffer.from(await rr1.arrayBuffer());
  const rr2 = await get(`${seg}?${q(id)}`, { headers: { range: "bytes=-500" } }); const rb2 = Buffer.from(await rr2.arrayBuffer());
  ok("segment Range on MISS → 206 with exact bytes", rr1.status === 206 && rb1.equals(file.subarray(100, 1100)) && rr1.headers.get("content-range") === `bytes 100-1099/${file.length}`, `${rr1.status} ${rr1.headers.get("content-range")}`);
  ok("segment suffix Range from the stored copy (HIT)", rr2.status === 206 && xc(rr2) === "HIT" && rb2.equals(file.subarray(file.length - 500)));
  const rr3 = await get(`${seg}?${q(id)}`, { headers: { range: `bytes=${file.length + 10}-` } });
  ok("unsatisfiable Range → 416", rr3.status === 416, String(rr3.status));
  ok("segment: origin fetched the whole object once", (await originCount(seg)) === 1);

  id = newId(); const mp4 = `/media/${id}/v1/full.mp4`;
  const full = fs.readFileSync(path.join(FIX, "full.mp4"));
  const s1 = await get(`${mp4}?${q(id)}`, { headers: { range: "bytes=5000000-5000999" } }); const sb1 = Buffer.from(await s1.arrayBuffer());
  let st = await stats();
  ok("full.mp4 seek (Range mid-file) → 206 exact bytes", s1.status === 206 && sb1.equals(full.subarray(5000000, 5001000)) && s1.headers.get("content-range") === `bytes 5000000-5000999/${full.length}`, `${s1.status} ${s1.headers.get("content-range")}`);
  ok("full.mp4 seek fetched only one 1 MiB slice from origin", JSON.stringify(st.counts["range:" + mp4]) === JSON.stringify(["bytes=4194304-5242879"]), JSON.stringify(st.counts["range:" + mp4]));
  const s2 = await get(`${mp4}?${q(id)}`, { headers: { range: "bytes=5100000-5100099" } }); await s2.arrayBuffer();
  ok("full.mp4 second seek inside the same slice → HIT", xc(s2) === "HIT", xc(s2));
  const s3 = await get(`${mp4}?${q(id)}`); const sb3 = Buffer.from(await s3.arrayBuffer());
  ok("full.mp4 full GET → 200, byte-identical", s3.status === 200 && sb3.equals(full), `${s3.status} ${sb3.length}/${full.length}`);
  const s4 = await get(`${mp4}?${q(id)}`); await s4.arrayBuffer();
  st = await stats();
  ok("full.mp4 fully cached: second full GET adds no origin requests", st.counts[mp4] === Math.ceil(full.length / 1048576), `origin slice fetches=${st.counts[mp4]} (file = ${Math.ceil(full.length / 1048576)} slices)`);

  // ---------- stampede: 50 viewers hit a cold object at once
  id = newId(); seg = `/media/${id}/v1/hls/r720/seg_00003.m4s`;
  const rs = await Promise.all(Array.from({ length: 50 }, () => get(`${seg}?${q(id)}`).then(async (r) => ({ s: r.status, c: xc(r), n: (await r.arrayBuffer()).byteLength }))));
  ok("stampede: 50 concurrent cold requests → 1 origin fetch, all 200", (await originCount(seg)) === 1 && rs.every((x) => x.s === 200), `origin=${await originCount(seg)} statuses=${[...new Set(rs.map((x) => x.s))]} cache=${JSON.stringify(rs.reduce((a, x) => ((a[x.c] = (a[x.c] || 0) + 1), a), {}))}`);

  // ---------- origin load for N viewers watching a whole video (HLS 360p ladder path)
  await fetch(CTL + "/reset");
  id = newId(); const N = 25;
  const files = ["hls/master.m3u8", "hls/r360/index.m3u8", "hls/r360/init.mp4", ...fs.readdirSync(path.join(FIX, "hls/r360")).filter((f) => f.endsWith(".m4s")).map((f) => "hls/r360/" + f), "poster.webp"];
  for (let v = 0; v < N; v++) {
    const qq = q(id, { uid: "viewer" + v });
    await Promise.all(files.map((f) => get(`/media/${id}/v1/${f}?${qq}`).then((r) => r.arrayBuffer())));
  }
  const tot = (await stats()).total;
  ok(`origin load: ${N} viewers × ${files.length} files = ${N * files.length} requests → origin served ${tot}`, tot === files.length, `${(100 * (1 - tot / (N * files.length))).toFixed(1)}% offloaded`);

  // ---------- purge
  id = newId(); const pp = `/media/${id}/v1/poster.webp`, ps = `/media/${id}/v1/hls/r240/seg_00000.m4s`;
  await (await get(`${pp}?${q(id)}`)).arrayBuffer(); await (await get(`${ps}?${q(id)}`)).arrayBuffer();
  ok("purge target cached", xc(await get(`${pp}?${q(id)}`)) === "HIT");
  const body = JSON.stringify({ prefixes: [`/media/${id}/`] });
  const bad = await fetch(PURGE, { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body });
  ok("purge with wrong secret → 401", bad.status === 401);
  const badBody = await fetch(PURGE, { method: "POST", headers: { authorization: `Bearer ${PSECRET}` }, body: JSON.stringify({ prefixes: ["/"] }) });
  ok("purge of '/' refused → 400", badBody.status === 400);
  const pr = await fetch(PURGE, { method: "POST", headers: { authorization: `Bearer ${PSECRET}`, "content-type": "application/json" }, body });
  ok("purge with secret → 204", pr.status === 204, String(pr.status));
  const after = await get(`${pp}?${q(id)}`); await after.arrayBuffer();
  const after2 = await get(`${ps}?${q(id)}`); await after2.arrayBuffer();
  ok("after purge: every file of the item bypasses the cache (origin decides)", xc(after) === "BYPASS" && xc(after2) === "BYPASS" && (await originCount(pp)) === 2, `${xc(after)} ${xc(after2)}`);
  if (process.env.CACHE_DIR) {
    const keys = [];
    const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : keys.push(fs.readFileSync(p).subarray(0, 1024).toString("latin1")); } };
    walk(process.env.CACHE_DIR);
    ok("purge removed the item's files from disk", !keys.some((h) => h.includes(`KEY: /media/${id}/`)) && keys.length > 0, `${keys.length} cache files left, none for the purged item`);
  }
  ok("purge endpoint not on the public port", (await get("/_purge", { method: "POST", body })).status === 404);

  // ---------- misc
  const opt = await get(`${pp}?${q(id)}`, { method: "OPTIONS" });
  ok("OPTIONS → 204 with CORS", opt.status === 204 && opt.headers.get("access-control-allow-headers") === "Range");
  ok("POST → 405", (await get(`${pp}?${q(id)}`, { method: "POST" })).status === 405);
  const hd = await get(`/media/${id}/v1/thumb.webp?${q(id)}`, { method: "HEAD" });
  ok("HEAD → 200", hd.status === 200);
  ok("non-media path → 404", (await get("/api/me")).status === 404);
  ok("/media/healthz proxied to origin (no-store)", (await get("/media/healthz")).status === 200);
  if (process.env.NGINX_LOG) {
    const log = fs.readFileSync(process.env.NGINX_LOG, "utf8");
    ok("access log never contains tokens", !/[?&]t=/.test(log) && !log.includes(SECRET), `${log.split("\n").length} lines checked`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  fs.writeFileSync(process.env.RESULTS || "/tmp/media-cache-results.json", JSON.stringify(results, null, 1));
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
