// Sponsored rooms + highlighted ads routes (mounted through server/monet/router.ts).
//   GET  /api/ads/slot?placement=hallway|explore → { ad: AdView | null }   (signed in; null while ADS_ENABLED is off)
//   POST /api/ads/event {id, placement, type: "click"|"join"}               (aggregate counters only)
//   Admin (isAdmin): GET /api/admin/ads → { enabled, campaigns, messagesAdmin }
//     POST /api/admin/ads {op:"create", campaign} | {op:"update", id, campaign} | {op:"review", id, action, note} | {op:"delete", id}
//     GET  /api/admin/ads/report?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=csv]
//   Files: GET /ad-files/<file>.jpg (re-encoded uploads on the volume)
import fs from "node:fs";
import path from "node:path";
import { json, send } from "../monet/http";
import { mount, onInit } from "../monet/registry";
import { AD_DIR, ads } from "./service";

onInit(() => ads().init());

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

mount("/api/ads", async ({ res, url, method, qs, uid, body }) => {
  const me = await uid();
  if (method === "GET" && url === "/api/ads/slot") {
    if (!me) return void json(res, 200, { ok: true, ad: null });
    return void json(res, 200, { ok: true, ad: ads().slot(me, qs.get("placement")) });
  }
  if (method === "POST" && url === "/api/ads/event") {
    if (!me) return void json(res, 401, { ok: false, error: "Not signed in" });
    const b = await body();
    return void json(res, 200, { ok: ads().event(me, b.id, b.placement, b.type) });
  }
  return false;
});

mount("/api/admin/ads", async ({ res, url, method, qs, admin, body }) => {
  const by = await admin();
  if (!by) return void json(res, 403, { ok: false, error: "Admins only" });
  const a = ads();
  if (method === "GET" && url === "/api/admin/ads") return void json(res, 200, { ok: true, enabled: a.enabled, campaigns: a.list(), now: Date.now() });
  if (method === "GET" && url === "/api/admin/ads/report") {
    const to = DAY_RE.test(qs.get("to") ?? "") ? qs.get("to")! : new Date().toISOString().slice(0, 10);
    const from = DAY_RE.test(qs.get("from") ?? "") ? qs.get("from")! : new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    if (qs.get("format") === "csv") {
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="sponsored-report-${from}-to-${to}.csv"`, "Cache-Control": "no-store" });
      return void res.end(await a.reportCsv(from, to));
    }
    return void json(res, 200, { ok: true, from, to, rows: await a.report(from, to) });
  }
  if (method === "POST" && url === "/api/admin/ads") {
    const b = await body();
    const input = (b.campaign ?? {}) as Record<string, unknown>;
    if (b.op === "create") return void send(res, await a.create(by, input));
    if (b.op === "update") return void send(res, await a.update(by, b.id, input));
    if (b.op === "review") return void send(res, await a.transition(by, b.id, b.action, b.note));
    if (b.op === "delete") return void send(res, await a.remove(b.id));
    return void json(res, 400, { ok: false, error: "Unknown op" });
  }
  return false;
});

/** /ad-files/<campaign>-<hex>.jpg */
mount("/ad-files", async ({ res, url, method }) => {
  if (method !== "GET" && method !== "HEAD") return false;
  await serveAdFile(url, res);
});
async function serveAdFile(url: string, res: import("node:http").ServerResponse) {
  const name = path.basename(url.slice("/ad-files/".length));
  if (!/^cmp_[\w-]{4,40}-[0-9a-f]{8}\.jpg$/.test(name)) return json(res, 404, { ok: false });
  try {
    const buf = await fs.promises.readFile(path.join(AD_DIR, name));
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
    res.end(buf);
  } catch {
    json(res, 404, { ok: false });
  }
}
