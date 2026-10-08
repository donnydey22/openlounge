// Live check of the signed-link gate on the deployed cache (run with `railway run --service media-cache`, so the
// production secret stays in the environment and is never printed). Works before the origin's internal port exists:
// a valid token passes the gate (origin answer, e.g. 502/200/404), bad tokens are DENIED at the cache.
import { createHmac, randomBytes } from "node:crypto";
const CACHE = process.env.CACHE || "https://media-cache-production.up.railway.app";
const S = process.env.MEDIA_SIGNING_SECRET;
const id = randomBytes(16).toString("hex"), path = `/media/${id}/v1/hls/r240/seg_00001.m4s`;
const q = ({ p = `/media/${id}/v1/`, ttl = 600, uid = "live_check" } = {}) => { const exp = Math.floor(Date.now() / 1000) + ttl; return `exp=${exp}&p=${encodeURIComponent(p)}&u=${uid}&t=${createHmac("sha256", S).update(`${p}|${exp}|${uid}`).digest("base64url")}`; };
const hit = async (qs) => { const r = await fetch(`${CACHE}${path}?${qs}`); return `${r.status} ${r.headers.get("x-cache-status")} cc=${r.headers.get("cache-control")}`; };
const good = q();
const rows = {
  "valid token (passes gate → origin)": await hit(good),
  "valid token again (error not cached)": await hit(good),
  "expired": await hit(q({ ttl: -10 })),
  "tampered token": await hit(good.replace(/t=(.)/, (_, c) => "t=" + (c === "A" ? "B" : "A"))),
  "tampered exp": await hit(good.replace(/exp=(\d+)/, (_, e) => "exp=" + (Number(e) + 99999))),
  "wrong prefix (other id)": await hit(q({ p: `/media/${randomBytes(16).toString("hex")}/v1/` })),
  "no token": await hit(""),
};
for (const [k, v] of Object.entries(rows)) console.log(k.padEnd(40), v);
