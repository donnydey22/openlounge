// Monetization routes (Premium, sponsored rooms/ads, creator & business accounts). Mounted from
// server/stickers/api.ts → handleMonetRoute, so the shared routers stay untouched.
//   Premium: GET /api/premium/config · GET /api/premium/me · POST /api/premium/prefs {appIcon?, badgeVisible?}
//            POST /api/premium/subscribe {plan} · POST /api/premium/subscription/sync {subscriptionId} · POST /api/premium/cancel
//            (one-time passes use the shared checkout: POST /api/stickers/checkout/create {packId:"premium:month"|"premium:year"})
//   Badges:  GET /api/badges?ids=u1,u2  → { badges: { [userId]: { premium?: true, verified?: "creator"|"business" } } }
import type { IncomingMessage, ServerResponse } from "node:http";
import { BadJson, BodyTooLarge } from "../httpsec";
import { isAdmin } from "../moderation";
import { authUser, body, isWrapper, json, send } from "./http";
import { premium } from "../premium/service";
import "./modules";
import { badgesOf, handlers, inits, mount, provideBadges, type Ctx } from "./registry";
import type { Badges } from "../../src/lib/premium/types";
export { badgesOf, mount, onInit, provideBadges } from "./registry";

const PREFIXES = ["/api/premium", "/api/admin/premium", "/api/badges", "/api/ads", "/api/admin/ads", "/api/creator", "/api/admin/creator", "/api/rooms/branding", "/api/r/", "/ad-files/"];
export function isMonetRoute(path: string) {
  return PREFIXES.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : p + "/") || path.startsWith(p + "?"));
}

let booted: Promise<void> | null = null;
export function initMonet() {
  if (!booted)
    booted = (async () => {
      await premium().init();
      for (const f of inits) await f();
    })().catch((err) => {
      booted = null;
      throw err;
    });
  return booted;
}

provideBadges((uid) => (premium().badge(uid) ? { premium: true } : {}));

mount("/api/premium", async ({ res, url, method, uid, body: b, wrapper }) => {
  const p = premium();
  if (method === "GET" && url === "/api/premium/config") return void json(res, 200, { ok: true, config: p.config(), wrapper });
  const me = await uid();
  if (!me) return void json(res, 401, { ok: false, error: "Not signed in" });
  if (method === "GET" && url === "/api/premium/me") return void json(res, 200, { ok: true, me: p.me(me) });
  if (method === "POST" && url === "/api/premium/prefs") return void send(res, await p.setPrefs(me, await b()));
  if (method === "POST" && url === "/api/premium/subscribe") return void send(res, await p.subscribe(me, (await b()).plan, { wrapper }));
  if (method === "POST" && url === "/api/premium/subscription/sync") return void send(res, await p.syncSubscription(me, (await b()).subscriptionId));
  if (method === "POST" && url === "/api/premium/cancel") return void send(res, await p.cancel(me));
  return false;
});

// support / comps: admins can grant or end complimentary Premium time (source "grant")
mount("/api/admin/premium", async ({ res, url, method, admin, body: b }) => {
  const by = await admin();
  if (!by) return void json(res, 403, { ok: false, error: "Admins only" });
  if (method === "POST" && url === "/api/admin/premium/grant") return void send(res, await premium().adminGrant(by, await b()));
  if (method === "POST" && url === "/api/admin/premium/revoke") return void send(res, await premium().adminRevoke(await b()));
  return false;
});

mount("/api/badges", async ({ res, qs }) => {
  const ids = (qs.get("ids") ?? "").split(",").filter((x) => /^[\w-]{1,80}$/.test(x)).slice(0, 100);
  const out: Record<string, Badges> = {};
  for (const id of ids) {
    const b = badgesOf(id);
    if (Object.keys(b).length) out[id] = b;
  }
  json(res, 200, { ok: true, badges: out }, "private, max-age=30");
});

export async function handleMonetRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = (req.url ?? "").split("?")[0];
  const qs = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const method = req.method ?? "GET";
  let uidP: Promise<string | null> | null = null;
  let bodyP: Promise<Record<string, unknown>> | null = null;
  const ctx: Ctx = {
    req,
    res,
    url,
    qs,
    method,
    wrapper: isWrapper(req),
    uid: () => (uidP ??= authUser(req)),
    body: () => (bodyP ??= body(req, url.startsWith("/api/admin/") || url.startsWith("/api/creator/") || url.startsWith("/api/rooms/branding") ? 3_000_000 : 32_768)),
    admin: async () => {
      const u = await ctx.uid();
      return u && isAdmin(u) ? u : null;
    },
  };
  try {
    await initMonet();
    for (const h of [...handlers].sort((a, b) => b.prefix.length - a.prefix.length)) {
      if (url === h.prefix || url.startsWith(h.prefix.endsWith("/") ? h.prefix : h.prefix + "/")) {
        const done = await h.fn(ctx);
        if (done !== false) return;
        break;
      }
    }
    json(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    if (err instanceof BodyTooLarge) return json(res, 413, { ok: false, error: "Too large" });
    if (err instanceof BadJson) return json(res, 400, { ok: false, error: "Bad JSON" });
    console.error("[monet] route error", url, (err as Error).message);
    if (!res.headersSent) json(res, 500, { ok: false, error: "Something went wrong" });
  }
}
