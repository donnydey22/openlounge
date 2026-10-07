// Custom Node server: Next.js app + raw WebSocket endpoint (/ws) + small HTTP API on one port.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import next from "next";
import { WsHub } from "./ws";
import { createJoinToken, livekit } from "./livekit";
import { registerRealtime } from "./realtime";
import { store } from "./store";
import fs from "node:fs";
import { deviceLabel, originAllowed } from "./auth";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOST || "0.0.0.0";

async function main() {
  // Durable storage first (Postgres via DATABASE_URL, else db.json) — fail fast before serving anything
  await store.init();

  const app = next({ dev, hostname: "localhost", port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const server = createServer((req, res) => {
    // uploaded profile photos: /avatars/<userId>?v=<version>
    if (req.url?.startsWith("/avatars/")) {
      const id = decodeURIComponent(req.url.slice("/avatars/".length).split("?")[0]);
      const f = store.avatarFile(id);
      if (!f) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": f.type, "Cache-Control": "public, max-age=31536000, immutable" });
      fs.createReadStream(f.file).pipe(res);
      return;
    }
    if (req.url?.startsWith("/api/") || /^\/auth\/(validate|refresh|logout)(\?|$)/.test(req.url ?? "")) {
      void api(req, res).catch((err) => {
        console.error("[api] failed", err);
        if (!res.headersSent) json(res, 503, { ok: false, reason: "unavailable" });
      });
      return;
    }
    // The app has no Server Actions: requests carrying a Next-Action header are internet scanners. Answer them
    // here so they don't reach Next.js (which logs a stack trace for every one and buries real log lines).
    if (req.headers["next-action"] !== undefined) {
      res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("Not found");
      return;
    }
    // Ensure HTML/RSC shells are never cached for a year (Android WebView / CDN).
    // Next may set s-maxage on documents — pin Cache-Control to no-store for non-static paths.
    const urlPath = (req.url ?? "").split("?")[0];
    const looksLikeDoc =
      !urlPath.startsWith("/_next/") &&
      !urlPath.startsWith("/avatars/") &&
      !urlPath.startsWith("/api/") &&
      !/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|map)$/i.test(urlPath);
    if (looksLikeDoc) {
      const noStore = "private, no-cache, no-store, max-age=0, must-revalidate";
      const origSetHeader = res.setHeader.bind(res);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (res as any).setHeader = (name: string, value: unknown) => {
        if (String(name).toLowerCase() === "cache-control") return origSetHeader("Cache-Control", noStore);
        return origSetHeader(name, value as never);
      };
      res.setHeader("Cache-Control", noStore);
      res.setHeader("Pragma", "no-cache");
      // openlounge-no-store
    }
    handle(req, res);
  });
  // Raw WebSocket endpoint at /ws (other upgrade requests, e.g. Next HMR, pass through)
  registerRealtime(new WsHub(server, "/ws", (req) => originAllowed(req.headers.origin, req.headers.host)));

  server.listen(port, hostname, () => {
    console.log(`\n  🎙️  Open Lounge ready on http://localhost:${port}  (${dev ? "dev" : "production"})`);
    console.log(`  🔊  Audio: ${livekit.enabled ? `LiveKit (${livekit.url})` : "disabled — set LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET"}`);
    console.log(`  🗄️   Storage: ${store.storageKind === "postgres" ? "Postgres (DATABASE_URL)" : "JSON file (DATABASE_URL not set)"}\n`);
  });

  // Flush pending writes to Postgres / db.json on shutdown (Railway sends SIGTERM on redeploy)
  const shutdown = (sig: string) => {
    console.log(`[server] ${sig} — saving data and exiting`);
    server.close();
    setTimeout(() => process.exit(0), 8000).unref(); // safety net if the database hangs
    store.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) break;
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

const bearer = (req: IncomingMessage) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();

/**
 * CORS. The web app and API share one origin, so browsers only send cross-origin requests from the other
 * prod domain (openlounge.app <-> *.up.railway.app) or from somewhere we don't trust. Allowed origins get
 * their exact origin echoed (never "*", no credentials/cookies are used — auth is a Bearer header);
 * anything else gets no CORS headers and a 403 on preflight / non-GET.
 * Returns false when the request was answered (preflight or rejected).
 */
function cors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin GET, native app, bot, curl
  if (!originAllowed(origin, req.headers.host)) {
    if (req.method === "OPTIONS" || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Origin" });
      res.end(JSON.stringify({ ok: false, reason: "origin" }));
      return false;
    }
    res.setHeader("Vary", "Origin");
    return true; // a GET is answered without CORS headers, so the browser won't expose it to that page
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
    });
    res.end();
    return false;
  }
  return true;
}

async function api(req: IncomingMessage, res: ServerResponse) {
  const url = (req.url ?? "").split("?")[0];
  if (!cors(req, res)) return;
  if (url === "/api/health") {
    const db = await Promise.race([store.storageStatus(), new Promise<null>((r) => setTimeout(() => r(null), 2000))]).catch(() => null);
    return json(res, 200, {
      ok: true,
      service: "openlounge",
      audio: livekit.enabled ? "livekit" : "disabled",
      storage: store.storageKind,
      db: db ? { connected: db.connected, schema: db.migrations.at(-1) ?? null, migrations: db.migrations.length } : { connected: null },
    });
  }

  // ---- auth (same handlers under /auth/* and /api/auth/*) ----
  const authPath = url.startsWith("/api/auth/") ? url.slice(4) : url;
  if (authPath === "/auth/validate" && (req.method === "GET" || req.method === "POST")) {
    // Authorization: Bearer <access token> (legacy session tokens are accepted too)
    const r = await store.authenticate(bearer(req));
    if (!r.ok) {
      res.setHeader("WWW-Authenticate", `Bearer error="invalid_token"`);
      return json(res, 401, { ok: false, reason: r.reason });
    }
    return json(res, 200, {
      ok: true,
      user: store.me(r.userId),
      following: store.followingIds(r.userId),
      unreadDms: store.unreadDmCount(r.userId),
      session: { id: r.sessionId, accessExpiresAt: r.accessExpiresAt },
    });
  }
  if (authPath === "/auth/refresh" && req.method === "POST") {
    // body { refreshToken } (a legacy session token works too) → new access + rotated refresh token
    const body = await readJson(req);
    const r = await store.refreshSession(body.refreshToken ?? bearer(req), deviceLabel(body.device, req.headers["user-agent"]));
    if (!r.ok) return json(res, 401, { ok: false, reason: r.reason });
    return json(res, 200, {
      ok: true,
      access: r.access,
      refresh: r.refresh,
      accessExpiresAt: r.accessExpiresAt,
      refreshExpiresAt: r.refreshExpiresAt,
      user: store.me(r.userId),
    });
  }
  if (authPath === "/auth/logout" && req.method === "POST") {
    // Authorization: Bearer <access token> and/or body { refreshToken }; body { all: true } signs out every device
    const body = await readJson(req);
    let r = await store.authenticate(bearer(req)).catch(() => null);
    if (!r?.ok && typeof body.refreshToken === "string") r = await store.authenticate(body.refreshToken).catch(() => null);
    if (r?.ok) store.revokeSession(r.sessionId, body.all === true ? { allForUser: r.userId } : {});
    return json(res, 200, { ok: true }); // idempotent: an already-dead session is "logged out" too
  }

  // LiveKit join token: Authorization: Bearer <access token>, body { roomId }
  if (url === "/api/livekit/token" && req.method === "POST") {
    if (!livekit.enabled) return json(res, 503, { ok: false, configured: false, error: "Live audio isn't configured on this server" });
    const auth = await store.authenticate(bearer(req));
    if (!auth.ok) return json(res, 401, { ok: false, reason: auth.reason, error: "Not signed in" });
    const userId = auth.userId;
    const { roomId } = await readJson(req);
    const role = store.roleOf(String(roomId ?? ""), userId);
    if (!role) return json(res, 403, { ok: false, error: "Join the room first" });
    const token = await createJoinToken({
      roomId: String(roomId),
      userId,
      name: store.publicUser(userId)?.name ?? "Member",
      canPublish: role !== "listener",
    });
    return json(res, 200, { ok: true, url: livekit.url, token });
  }
  // Social links: Authorization: Bearer <access token>, body { links: { instagram?: string|null, ... } }
  // Partial update: listed keys are set (handle or URL, normalized) or cleared ("" / null); others are kept.
  if (url === "/api/me/social-links" && (req.method === "POST" || req.method === "PUT")) {
    const auth = await store.authenticate(bearer(req));
    if (!auth.ok) {
      res.setHeader("WWW-Authenticate", `Bearer error="invalid_token"`);
      return json(res, 401, { ok: false, reason: auth.reason, error: "Not signed in" });
    }
    const body = await readJson(req);
    const r = store.updateSocialLinks(auth.userId, body.links);
    if (!r.ok) return json(res, r.status, { ok: false, error: r.error, ...("errors" in r ? { errors: r.errors } : {}) });
    return json(res, 200, { ok: true, user: r.user });
  }
  json(res, 404, { ok: false, error: "Not found" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
