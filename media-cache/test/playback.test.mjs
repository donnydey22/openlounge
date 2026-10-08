// HLS playback through the cache in Chromium, Firefox and WebKit (Playwright). The page is served from a different
// origin than the cache, so CORS is exercised. hls.js where MSE exists, native HLS otherwise (Safari/iOS path).
//   HLSJS=/path/to/hls.min.js PLAYWRIGHT=/workspace/qa/node_modules/playwright CACHE=... node test/playback.test.mjs
import http from "node:http";
import fs from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium, firefox, webkit } = require(process.env.PLAYWRIGHT || "/workspace/qa/node_modules/playwright");
const CACHE = process.env.CACHE || "http://127.0.0.1:18080";
const SECRET = process.env.MEDIA_SIGNING_SECRET;
const HLSJS = fs.readFileSync(process.env.HLSJS || "/tmp/mc-browser/node_modules/hls.js/dist/hls.min.js");
const ID = process.env.MEDIA_ID || randomBytes(16).toString("hex");

function q(uid) {
  const p = `/media/${ID}/v1/`, exp = Math.floor(Date.now() / 1000) + 1800;
  const t = createHmac("sha256", SECRET).update(`${p}|${exp}|${uid}`).digest("base64url");
  return `exp=${exp}&p=${encodeURIComponent(p)}&u=${uid}&t=${t}`;
}
const page = `<!doctype html><meta charset=utf-8><video id=v muted playsinline style="width:640px"></video><script src="/hls.js"></script>
<script>
const v = document.getElementById('v'); const src = new URLSearchParams(location.search).get('src');
window.report = { mode: '', levels: [], errors: [], switched: [] };
if (window.Hls && Hls.isSupported()) {
  window.report.mode = 'hls.js ' + Hls.version;
  const h = new Hls({ startLevel: 0, capLevelToPlayerSize: false }); window.hls = h;
  h.on(Hls.Events.MANIFEST_PARSED, (_, d) => { window.report.levels = d.levels.map(l => l.height); });
  h.on(Hls.Events.LEVEL_SWITCHED, (_, d) => window.report.switched.push(h.levels[d.level].height));
  h.on(Hls.Events.ERROR, (_, d) => window.report.errors.push(d.details + (d.fatal ? ' (fatal)' : '')));
  h.loadSource(src); h.attachMedia(v);
} else if (v.canPlayType('application/vnd.apple.mpegurl')) { window.report.mode = 'native HLS'; v.src = src; }
else window.report.mode = 'none';
v.addEventListener('error', () => window.report.errors.push('video error ' + (v.error && v.error.code)));
v.play().catch(e => window.report.errors.push('play: ' + e.message));
</script>`;
const srv = http.createServer((req, res) => {
  if (req.url.startsWith("/hls.js")) { res.writeHead(200, { "Content-Type": "text/javascript" }); return res.end(HLSJS); }
  res.writeHead(200, { "Content-Type": "text/html" }); res.end(page);
}).listen(18090, "127.0.0.1");

const out = [];
let fails = 0;
for (const [name, bt, opts] of [["chromium (Google Chrome)", chromium, { channel: "chrome" }], ["firefox", firefox, {}], ["webkit", webkit, {}]]) {
  const browser = await bt.launch({ headless: true, ...opts });
  const run = async (uid, forceTop) => {
    const ctx = await browser.newContext(); const pg = await ctx.newPage();
    const resp = [];
    pg.on("response", (r) => { if (r.url().startsWith(CACHE)) resp.push({ f: new URL(r.url()).pathname.split("/v1/")[1], s: r.status(), c: r.headers()["x-cache-status"] }); });
    const t0 = Date.now();
    await pg.goto(`http://127.0.0.1:18090/?src=${encodeURIComponent(`${CACHE}/media/${ID}/v1/hls/master.m3u8?${q(uid)}`)}`);
    let started = 0;
    for (let i = 0; i < 100; i++) { const ct = await pg.evaluate(() => document.getElementById("v").currentTime); if (ct > 0 && !started) started = Date.now() - t0; if (ct > 2) break; await pg.waitForTimeout(100); }
    if (forceTop) {
      await pg.evaluate(() => { if (window.hls) window.hls.currentLevel = window.hls.levels.length - 1; });
      await pg.waitForTimeout(500);
    }
    await pg.evaluate(() => { const v = document.getElementById("v"); v.currentTime = 17; });
    await pg.waitForTimeout(2500);
    const rep = await pg.evaluate(() => ({ ...window.report, t: document.getElementById("v").currentTime, w: document.getElementById("v").videoWidth, h: document.getElementById("v").videoHeight }));
    await ctx.close();
    return { rep, started, resp };
  };
  const a = await run("viewer_a_" + name.split(" ")[0], true);
  const b = await run("viewer_b_" + name.split(" ")[0], true);
  await browser.close();
  const passA = a.rep.t > 17 && !a.rep.errors.some((e) => /fatal|video error/.test(e)) && a.resp.every((r) => r.s === 200 || r.s === 206);
  const hitsB = b.resp.filter((r) => r.c === "HIT").length;
  const line = { browser: name, mode: a.rep.mode, startMs: a.started, levels: a.rep.levels, switched: a.rep.switched, played: +a.rep.t.toFixed(1), frame: `${a.rep.w}x${a.rep.h}`, requests: a.resp.length, statuses: [...new Set(a.resp.map((r) => r.s))], firstViewerCache: a.resp.reduce((m, r) => ((m[r.c] = (m[r.c] || 0) + 1), m), {}), secondViewerHits: `${hitsB}/${b.resp.length}`, secondStartMs: b.started, errors: a.rep.errors };
  if (!passA || !(b.rep.t > 17)) fails++;
  out.push(line);
  console.log(`${passA ? "PASS" : "FAIL"}  ${JSON.stringify(line)}`);
}
srv.close();
fs.writeFileSync(process.env.RESULTS || "/tmp/media-cache-playback.json", JSON.stringify(out, null, 1));
process.exit(fails ? 1 : 0);
