// HTTP routes for the sticker library. Mounted from server/index.ts (one small hook) so the shared API router
// (server/http.ts) stays untouched.
//   GET  /sticker-files/<path>                         sticker assets (immutable, hashed names; Lottie gz)
//   GET  /.well-known/apple-developer-merchantid-domain-association   Apple Pay domain verification (env/file)
//   GET  /api/stickers/config | /packs?q=&category= | /packs/:id | /search?q=
//   GET  /api/stickers/me      POST /api/stickers/me/packs {packId, add} | /me/order {packIds} | /me/favorites {packId, stickerId, fav} | /me/recents {packId, stickerId}
//   POST /api/stickers/checkout/create {packId, funding}  POST /api/stickers/checkout/capture {orderId}
//   GET  /api/stickers/receipts   POST /api/stickers/restore
//   POST /api/paypal/webhook
//   Admin: GET/POST /api/admin/stickers/packs, POST /api/admin/stickers/packs/:id, POST …/:id/stickers, DELETE …/:id/stickers/:sid
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { store } from "../store";
import { isAdmin } from "../moderation";
import { DATA_DIR } from "../persistence";
import { BadJson, BodyTooLarge, readJsonBody } from "../httpsec";
import { sendMail } from "../authx/mailer";
import { stickers } from "./service";
import { UPLOAD_DIR, addSticker, createPack, removeSticker, updatePack } from "./admin";
import { handleMonetRoute, initMonet, isMonetRoute } from "../monet/router";

const PUBLIC_DIR = path.join(process.cwd(), "public", "sticker-files");
const FLUENT_DIR = path.join(process.cwd(), "public", "emoji", "fluent");
const WELL_KNOWN = "/.well-known/apple-developer-merchantid-domain-association";

const json = (res: ServerResponse, status: number, body: unknown, cache = "no-store") => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache });
  res.end(JSON.stringify(body));
};
const bearer = (req: IncomingMessage) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
const isWrapper = (req: IncomingMessage) => /OpenLounge(Android|iOS)/i.test(String(req.headers["user-agent"] ?? ""));

let initP: Promise<void> | null = null;
/** Boot the service (idempotent). Called at server start; routes also await it. */
export function initStickers() {
  if (!initP) {
    const svc = stickers();
    svc.users = {
      email: (uid) => store.identitiesOf(uid).find((i) => i.verified && i.email)?.email ?? null,
      name: (uid) => store.publicUser(uid)?.name ?? "there",
      exists: (uid) => store.users.has(uid),
    };
    svc.mailer = (m) => sendMail(m);
    initP = svc.init().then(() => initMonet().catch((e) => console.warn("[monet] init deferred:", (e as Error).message))).catch((err) => {
      console.error("[stickers] init failed", (err as Error).message);
      initP = null;
      throw err;
    });
  }
  return initP;
}

/** Paths this module answers (cheap prefix check for the server's router). */
export function isStickerRoute(url: string) {
  const p = url.split("?")[0];
  return isMonetRoute(p) || p.startsWith("/sticker-files/") || p === WELL_KNOWN || p.startsWith("/api/stickers") || p === "/api/paypal/webhook" || p.startsWith("/api/admin/stickers");
}

const TYPES: Record<string, string> = { ".webp": "image/webp", ".png": "image/png", ".gif": "image/gif" };

function serveFile(req: IncomingMessage, res: ServerResponse, rel: string) {
  // rel: "noto/<file>" (in the image) or "u/<packId>/<file>" (uploads on the volume). No traversal.
  // "fluent/<cp>.webp" | "fluent/p/<cp>.webp": Microsoft Fluent animated emoji, served in place from public/emoji/fluent (no copy)
  if (!/^(noto\/[\w.-]+|fluent\/(p\/)?[\w-]+\.webp|u\/[\w-]+\/[\w.-]+)$/.test(rel) || rel.includes("..")) return json(res, 404, { ok: false });
  const file = rel.startsWith("u/") ? path.join(UPLOAD_DIR, rel.slice(2)) : rel.startsWith("fluent/") ? path.join(FLUENT_DIR, rel.slice(7)) : path.join(PUBLIC_DIR, rel);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { ok: false });
    const gz = file.endsWith(".json.gz");
    const headers: Record<string, string | number> = {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": st.size,
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      ETag: `"${st.size.toString(36)}-${st.mtimeMs.toString(36)}"`,
    };
    if (gz) {
      headers["Content-Type"] = "application/json";
      headers["Content-Encoding"] = "gzip"; // every supported browser accepts gzip
      headers.Vary = "Accept-Encoding";
    } else headers["Content-Type"] = TYPES[path.extname(file)] ?? "application/octet-stream";
    if (req.headers["if-none-match"] === headers.ETag) return void res.writeHead(304, { ETag: String(headers.ETag), "Cache-Control": String(headers["Cache-Control"]) }).end();
    res.writeHead(200, headers);
    if (req.method === "HEAD") return void res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function appleAssociation(res: ServerResponse) {
  // Apple requires: 200 (no redirect), HTTPS, Content-Type application/octet-stream. Donny supplies the file later
  // (PayPal dashboard → Apple Pay → download), via env APPLE_PAY_DOMAIN_ASSOCIATION or $DATA_DIR/<filename>.
  const env = process.env.APPLE_PAY_DOMAIN_ASSOCIATION;
  let body: Buffer | null = env ? Buffer.from(env.replace(/\\n/g, "\n")) : null;
  if (!body) {
    for (const f of [path.join(DATA_DIR, "apple-developer-merchantid-domain-association"), path.join(process.cwd(), "public", ".well-known", "apple-developer-merchantid-domain-association")])
      if (fs.existsSync(f)) {
        body = fs.readFileSync(f);
        break;
      }
  }
  if (!body) return void res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("Not found");
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length, "Cache-Control": "public, max-age=3600" });
  res.end(body);
}

async function readRaw(req: IncomingMessage, limit = 256_000): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new BodyTooLarge();
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleStickerRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = (req.url ?? "").split("?")[0];
  const qs = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const method = req.method ?? "GET";
  try {
    if (url.startsWith("/sticker-files/") && (method === "GET" || method === "HEAD")) return serveFile(req, res, decodeURIComponent(url.slice("/sticker-files/".length)));
    if (url === WELL_KNOWN && (method === "GET" || method === "HEAD")) return appleAssociation(res);

    await initStickers();
    // Premium / ads / creator accounts share this mount point and the sticker PayPal pipeline
    if (isMonetRoute(url)) return handleMonetRoute(req, res);
    const svc = stickers();

    if (url === "/api/paypal/webhook" && method === "POST") {
      const raw = await readRaw(req);
      const r = await svc.webhook(req.headers, raw);
      return json(res, r.status, r.body);
    }

    // public catalog (cacheable briefly at the edge/browser; user-specific state comes from /me)
    if (method === "GET" && url === "/api/stickers/config") return json(res, 200, { ok: true, config: svc.config(), wrapper: isWrapper(req) });
    if (method === "GET" && url === "/api/stickers/packs")
      return json(res, 200, { ok: true, packs: svc.list({ q: qs.get("q") ?? undefined, category: qs.get("category") ?? undefined }), categories: svc.categories() }, "public, max-age=60");
    if (method === "GET" && url === "/api/stickers/search") return json(res, 200, { ok: true, results: svc.searchStickers(qs.get("q") ?? "") }, "public, max-age=60");
    const one = url.match(/^\/api\/stickers\/packs\/([\w-]{1,64})$/);
    if (method === "GET" && one) {
      const p = svc.pack(one[1]);
      if (!p) return json(res, 404, { ok: false, error: "Sticker pack not found" });
      return json(res, 200, { ok: true, pack: p }, "public, max-age=60");
    }

    // everything below needs a session
    const auth = await store.authenticate(bearer(req));
    if (!auth.ok) {
      res.setHeader("WWW-Authenticate", `Bearer error="invalid_token"`);
      return json(res, 401, { ok: false, reason: auth.reason, error: "Not signed in" });
    }
    const uid = auth.userId;
    const body = method === "POST" ? await readJsonBody(req, url.startsWith("/api/admin/stickers") ? 2_000_000 : 16_384).catch((e) => { throw e; }) : {};
    const out = (r: { ok: boolean; status?: number; error?: string } & Record<string, unknown>) => {
      if (!r.ok) return json(res, r.status ?? 400, { ok: false, error: r.error, ...(r.retry ? { retry: true } : {}) });
      const { status: _s, ...rest } = r;
      void _s;
      return json(res, 200, rest);
    };

    if (method === "GET" && url === "/api/stickers/me") return json(res, 200, { ok: true, mine: await svc.mine(uid) });
    if (method === "POST" && url === "/api/stickers/me/packs") return out(await svc.setAdded(uid, String(body.packId ?? ""), body.add !== false));
    if (method === "POST" && url === "/api/stickers/me/order") return out(await svc.reorder(uid, body.packIds));
    if (method === "POST" && url === "/api/stickers/me/favorites") return out(await svc.setFavorite(uid, body.packId, body.stickerId, body.fav !== false));
    if (method === "POST" && url === "/api/stickers/me/recents") return out(await svc.used(uid, body.packId, body.stickerId));
    if (method === "POST" && url === "/api/stickers/checkout/create") return out(await svc.createCheckout(uid, body.packId, body.funding, { wrapper: isWrapper(req) }));
    if (method === "POST" && url === "/api/stickers/checkout/capture") return out(await svc.capture(uid, body.orderId));
    if (method === "GET" && url === "/api/stickers/receipts") return json(res, 200, { ok: true, receipts: await svc.receipts(uid) });
    if (method === "POST" && url === "/api/stickers/restore") return out(await svc.restore(uid));

    // lets the admin page check access without a 403 (which browsers log as a console error)
    if (method === "GET" && url === "/api/admin/stickers/access") return json(res, 200, { ok: true, admin: isAdmin(uid) });
    if (url.startsWith("/api/admin/stickers")) {
      if (!isAdmin(uid)) return json(res, 403, { ok: false, error: "Admins only" });
      if (method === "GET" && url === "/api/admin/stickers/packs") return json(res, 200, { ok: true, packs: svc.list({ includeDrafts: true }).filter((p) => !p.builtin).concat(svc.list().filter((p) => p.builtin)), config: svc.config() });
      if (method === "POST" && url === "/api/admin/stickers/packs") return out(await createPack(svc, uid, body));
      const m = url.match(/^\/api\/admin\/stickers\/packs\/([\w-]{1,64})(?:\/stickers(?:\/([\w-]{1,64}))?)?$/);
      if (m) {
        const [, packId, sid] = m;
        const isStickers = url.includes("/stickers/packs/" + packId + "/stickers");
        if (method === "GET" && !isStickers) {
          const p = svc.pack(packId, { includeDrafts: true });
          return p ? json(res, 200, { ok: true, pack: p }) : json(res, 404, { ok: false, error: "Pack not found" });
        }
        if (method === "POST" && !isStickers) return out(await updatePack(svc, uid, packId, body));
        if (method === "POST" && isStickers && !sid) return out(await addSticker(svc, uid, packId, body));
        if (method === "DELETE" && isStickers && sid) return out(await removeSticker(svc, uid, packId, sid));
      }
    }
    return json(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    if (err instanceof BodyTooLarge || err instanceof BadJson) return json(res, err.status, { ok: false, error: err.message });
    console.error("[stickers] route failed", url, (err as Error).message);
    if (!res.headersSent) json(res, 500, { ok: false, error: "Something went wrong" });
  }
}
