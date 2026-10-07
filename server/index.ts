// Custom Node server: Next.js app + raw WebSocket endpoint (/ws) + small HTTP API on one port.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import next from "next";
import { WsHub } from "./ws";
import { createJoinToken, livekit } from "./livekit";
import { registerRealtime } from "./realtime";
import { store } from "./store";
import fs from "node:fs";
import { deviceLabel, originAllowed } from "./auth";
import { log, metrics, requestContext } from "./log";
import { BadJson, BodyTooLarge, RateLimiter, clientIp, readJsonBody, requestId, securityHeaders, sendJson, wwwRedirect } from "./httpsec";
import { isTransientPgError } from "./pg";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOST || "0.0.0.0";

async function main() {
  // Durable storage first (Postgres via DATABASE_URL, else db.json) — fail fast before serving anything
  await store.init();

  const app = next({ dev, hostname: "localhost", port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const secHeaders = securityHeaders();
  let inFlight = 0;
  let draining = false;
  metrics.gauge("http_in_flight", () => inFlight);

  const server = createServer((req, res) => {
    const rid = requestId(req);
    res.setHeader("X-Request-Id", rid);
    // www → apex (needs the www custom domain attached on Railway first; harmless until then)
    const www = wwwRedirect(req.headers.host, req.url);
    if (www) {
      res.writeHead(308, { Location: www, "Cache-Control": "public, max-age=3600" }).end();
      return;
    }
    for (const [k, v] of Object.entries(secHeaders)) res.setHeader(k, v);
    metrics.inc("http_requests_total");
    inFlight++;
    const t0 = Date.now();
    res.once("close", () => {
      inFlight--;
      if (res.statusCode >= 500) metrics.inc("http_5xx_total");
      if (req.url?.startsWith("/api/") || req.url?.startsWith("/auth/") || res.statusCode >= 500)
        log.info("http", { requestId: rid, method: req.method, path: (req.url ?? "").split("?")[0], status: res.statusCode, ms: Date.now() - t0 });
    });
    if (draining) res.setHeader("Connection", "close");
    requestContext.run({ requestId: rid }, () => route(req, res));
  });

  const route = (req: IncomingMessage, res: ServerResponse) => {
    // liveness: the process is up and the event loop answers. Never touches dependencies.
    if (req.url === "/healthz") return json(res, 200, { ok: true, uptimeS: Math.round(process.uptime()) });
    // readiness: DB round-trip + LiveKit reachability; 503 while draining or when the DB is down
    if (req.url === "/readyz") {
      void readiness(draining).then((r) => json(res, r.ok ? 200 : 503, r));
      return;
    }
    if (req.url === "/metrics") {
      const tok = process.env.METRICS_TOKEN;
      if ((tok && bearer(req) !== tok) || (!tok && !dev)) return json(res, 404, { ok: false, error: "Not found" });
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4", "Cache-Control": "no-store" }).end(metrics.prometheus());
      return;
    }
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
        if (err instanceof BodyTooLarge || err instanceof BadJson) return json(res, err.status, { ok: false, error: err.message });
        const transient = isTransientPgError(err);
        log.error("api failed", { path: req.url, err, transient });
        if (!res.headersSent) json(res, transient ? 503 : 500, { ok: false, reason: transient ? "unavailable" : "server_error", requestId: res.getHeader("X-Request-Id") });
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
  };
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 65_000; // > typical proxy idle timeout, avoids races on reused connections
  // Raw WebSocket endpoint at /ws (other upgrade requests, e.g. Next HMR, pass through)
  const hub = new WsHub(server, "/ws", (req) => originAllowed(req.headers.origin, req.headers.host));
  registerRealtime(hub);

  server.listen(port, hostname, () => {
    log.info("ready", {
      url: `http://localhost:${port}`,
      mode: dev ? "dev" : "production",
      audio: livekit.enabled ? livekit.url : "disabled",
      storage: store.storageKind,
      csp: process.env.CSP === "0" ? "off" : process.env.CSP_REPORT_ONLY === "1" ? "report-only" : "enforce",
    });
  });

  // Graceful shutdown (Railway sends SIGTERM on redeploy): stop accepting → close sockets with 1012 so clients
  // reconnect to the new deploy → let in-flight HTTP requests finish → flush the store → close the pg pool.
  const SHUTDOWN_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 15_000);
  const shutdown = async (sig: string, code = 0) => {
    if (draining) return;
    draining = true;
    log.info("shutdown begin", { sig, ws: hub.size, inFlight });
    const hard = setTimeout(() => {
      log.error("shutdown timed out, forcing exit", { inFlight, ws: hub.size });
      process.exit(code || 1);
    }, SHUTDOWN_MS);
    hard.unref();
    server.close(); // stop accepting; resolves when keep-alive sockets end
    server.closeIdleConnections();
    await hub.drain(Math.min(5000, SHUTDOWN_MS / 3)).catch((err) => log.warn("ws drain failed", { err }));
    const until = Date.now() + SHUTDOWN_MS / 2;
    while (inFlight > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    server.closeAllConnections();
    await store.close().catch((err) => log.error("store close failed", { err }));
    log.info("shutdown complete", { sig });
    process.exit(code);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    metrics.inc("uncaught_exceptions_total");
    log.error("uncaughtException", { err });
    void shutdown("uncaughtException", 1); // state may be corrupt: flush what we can and restart (Railway ON_FAILURE)
  });
}

process.on("unhandledRejection", (reason) => {
  metrics.inc("unhandled_rejections_total");
  log.error("unhandledRejection", { err: reason instanceof Error ? reason : new Error(String(reason)) });
});

// ---------- readiness ----------
let lkCache: { at: number; ok: boolean; ms: number; error?: string } | null = null;
async function liveKitReachable() {
  if (!livekit.enabled) return { ok: true, ms: 0, skipped: true };
  if (lkCache && Date.now() - lkCache.at < 10_000) return lkCache;
  const t0 = Date.now();
  try {
    // LiveKit's HTTP root answers 200 "OK"; any HTTP response proves the server (and TLS) is reachable
    const r = await fetch(livekit.url.replace(/^ws/, "http"), { signal: AbortSignal.timeout(2000) });
    lkCache = { at: Date.now(), ok: r.status < 500, ms: Date.now() - t0 };
  } catch (err) {
    lkCache = { at: Date.now(), ok: false, ms: Date.now() - t0, error: (err as Error).message };
  }
  return lkCache;
}

async function readiness(draining: boolean) {
  const [db, lk] = await Promise.all([store.ping(2000), liveKitReachable()]);
  const requireLk = process.env.READYZ_REQUIRE_LIVEKIT === "1";
  const ok = !draining && db.ok && (lk.ok || !requireLk);
  if (!ok) metrics.inc("readyz_fail_total");
  return { ok, draining, db, livekit: { ...lk, required: requireLk, at: undefined }, storage: store.storageKind };
}

// ---------- HTTP rate limits (per client IP) ----------
const limits = {
  auth: new RateLimiter(Number(process.env.RL_AUTH_PER_MIN || 30), 60_000),
  livekit: new RateLimiter(Number(process.env.RL_LIVEKIT_PER_MIN || 60), 60_000),
  api: new RateLimiter(Number(process.env.RL_API_PER_MIN || 300), 60_000),
};
function limited(req: IncomingMessage, res: ServerResponse, bucket: keyof typeof limits) {
  const ip = clientIp(req);
  if (limits[bucket].take(ip)) return false;
  metrics.inc(`http_rate_limited_${bucket}_total`);
  sendJson(res, 429, { ok: false, reason: "rate_limited", error: "Too many requests" }, { "Retry-After": String(limits[bucket].retryAfter(ip)) });
  return true;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** JSON body, capped at 16 KB (413 above that, 400 on malformed JSON — handled in the api() catch). */
const readJson = (req: IncomingMessage) => readJsonBody(req, Number(process.env.HTTP_MAX_BODY_BYTES || 16_384));

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
  if (url !== "/api/health") {
    const bucket = url.includes("/auth/") ? "auth" : url === "/api/livekit/token" ? "livekit" : "api";
    if (limited(req, res, bucket)) return;
  }
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
    if (typeof roomId !== "string" || !/^[\w-]{1,64}$/.test(roomId)) return json(res, 400, { ok: false, error: "roomId required" });
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
  json(res, 404, { ok: false, error: "Not found" });
}

main().catch((err) => {
  log.error("boot failed", { err });
  process.exit(1);
});
