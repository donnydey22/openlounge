// Business & creator account routes (mounted through server/monet/registry.ts). All refuse while CREATOR_ENABLED is off,
// except config. Payment for verification uses the shared checkout:
//   POST /api/stickers/checkout/create {packId: "verify:<kind>:<requestId>"} (web only; never in the apps)
import fs from "node:fs";
import path from "node:path";
import { json, send } from "../monet/http";
import { mount, onInit, provideBadges } from "../monet/registry";
import { CREATOR_FILES, creator } from "./service";

onInit(() => creator().init());
provideBadges((uid) => {
  const v = creator().verifiedOf(uid);
  return v ? { verified: v } : {};
});

mount("/api/creator", async ({ res, url, method, qs, uid, body, wrapper }) => {
  const c = creator();
  if (method === "GET" && url === "/api/creator/config") return void json(res, 200, { ok: true, config: c.config(), wrapper });
  const me = await uid();
  if (!me) return void json(res, 401, { ok: false, error: "Not signed in" });
  if (!c.enabled) return void json(res, 503, { ok: false, error: "Creator accounts aren't available yet" });
  if (method === "GET" && url === "/api/creator/me") return void json(res, 200, { ok: true, ...c.me(me), config: c.config() });
  if (method === "GET" && url === "/api/creator/analytics") return void json(res, 200, { ok: true, analytics: c.analytics(me, Math.max(1, Math.min(365, Number(qs.get("days")) || 30))) });
  if (method === "POST" && url === "/api/creator/profile") return void send(res, await c.setProfile(me, await body()));
  if (method === "POST" && url === "/api/creator/verify") return void send(res, await c.apply(me, await body()));
  if (method === "POST" && url === "/api/creator/verify/withdraw") return void send(res, await c.withdraw(me));
  if (method === "POST" && url === "/api/creator/branding") return void send(res, await c.saveBranding(me, await body()));
  if (method === "POST" && url === "/api/creator/series") return void send(res, await c.saveSeries(me, await body()));
  if (method === "POST" && url === "/api/creator/series/delete") return void send(res, await c.deleteSeries(me, (await body()).id));
  return false;
});

// public: brand page + room branding (null while off)
mount("/api/r", async ({ res, url, method }) => {
  if (method !== "GET") return false;
  const p = creator().page(decodeURIComponent(url.slice("/api/r/".length)));
  json(res, p ? 200 : 404, p ? { ok: true, ...p } : { ok: false, error: "Not found" }, p ? "public, max-age=30" : "no-store");
});
mount("/api/rooms/branding", async ({ res, url, method }) => {
  if (method !== "GET") return false;
  json(res, 200, { ok: true, branding: creator().brandingForHost(decodeURIComponent(url.slice("/api/rooms/branding/".length))) }, "public, max-age=60");
});

mount("/api/admin/creator", async ({ res, url, method, admin, body }) => {
  const by = await admin();
  if (!by) return void json(res, 403, { ok: false, error: "Admins only" });
  const c = creator();
  if (method === "GET" && url === "/api/admin/creator") {
    const verified = c.badges.all().map((b) => ({ ...b, name: c.requests.get(b.requestId)?.legalName ?? "" }));
    return void json(res, 200, { ok: true, enabled: c.enabled, queue: c.queue(), awaitingPayment: c.requests.where((r) => r.status === "awaiting_payment").length, verified });
  }
  if (method === "GET" && url.startsWith("/api/admin/creator/doc/")) {
    const d = await c.readDoc(path.basename(url));
    if (!d) return void json(res, 404, { ok: false });
    res.writeHead(200, { "Content-Type": d.mime, "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline", "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
    return void res.end(d.buf);
  }
  if (method === "POST" && url === "/api/admin/creator") {
    const b = await body();
    if (b.op === "approve" || b.op === "reject") return void send(res, await c.decide(by, b.id, b.op === "approve", b.note));
    if (b.op === "revoke") return void send(res, await c.revokeBadge(by, b.userId, b.note));
    return void json(res, 400, { ok: false, error: "Unknown op" });
  }
  return false;
});

mount("/creator-files", async ({ res, url, method }) => {
  if (method !== "GET" && method !== "HEAD") return false;
  const name = path.basename(url);
  if (!/^[\w-]{3,80}-(logo|cover)-[0-9a-f]{8}\.webp$/.test(name)) return void json(res, 404, { ok: false });
  try {
    const buf = await fs.promises.readFile(path.join(CREATOR_FILES, name));
    res.writeHead(200, { "Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
    res.end(buf);
  } catch {
    json(res, 404, { ok: false });
  }
});
