// Custom Node server: Next.js app + raw WebSocket endpoint (/ws) + small HTTP API on one port.
import { belowFloor, gateExempt, unsupportedPageHtml } from "../src/lib/browserFloor";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import next from "next";
import { WsHub } from "./ws";
import { createJoinToken, livekit } from "./livekit";
import { registerRealtime } from "./realtime";
import { store } from "./store";
import fs from "node:fs";
import { originAllowed } from "./auth";
import { api, isApiRequest, json } from "./http";
import { logProviderStatus } from "./authx/providers";
import { initPush } from "./push";
import { startDeletionQueue } from "./deletionQueue";
import { demoOtpEnabled, firebaseConfigured } from "./firebase";
import { log, metrics, requestContext } from "./log";
import { BadJson, BodyTooLarge, RateLimiter, clientIp, requestId, securityHeaders, sendJson, wwwRedirect } from "./httpsec";
import { isTransientPgError } from "./pg";
import { handleStickerRoute, initStickers, isStickerRoute } from "./stickers/api";
import { media } from "./media/service";
import { isMediaFileRequest } from "./media/http";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOST || "0.0.0.0";

async function main() {
  // Durable storage first (Postgres via DATABASE_URL, else db.json) — fail fast before serving anything
  await store.init();
  // media metadata + expiry timers attach to the loaded DMs (files on the volume at UPLOAD_DIR)
  await media.ready();
  logProviderStatus();
  initPush();
  startDeletionQueue(); // store compliance: operator-initiated account deletions (account_deletion_requests)
  // sticker library (catalog + PayPal); non-fatal: chat works without it
  void initStickers().catch(() => {});
  log.info("phone auth", { firebase: firebaseConfigured(), demoOtp: demoOtpEnabled() });

  const app = next({ dev, hostname: "localhost", port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const secHeaders = securityHeaders();
  let inFlight = 0;
  let draining = false;
  metrics.gauge("http_in_flight", () => inFlight);
  metrics.gauge("process_heap_used_bytes", () => process.memoryUsage().heapUsed);

  const server = createServer((req, res) => {
    const rid = requestId(req);
    res.setHeader("X-Request-Id", rid);
    // www → apex (needs the www custom domain attached on Railway first; harmless until then)
    const www = wwwRedirect(req.headers.host, req.url);
    if (www) {
      res.writeHead(308, { Location: www, "Cache-Control": "public, max-age=3600" }).end();
      return;
    }
    // legal page aliases (store listings / old links): 301 to the canonical pages, query string kept
    const legal = /^\/(privacy-policy|terms-of-service)\/?(\?.*)?$/.exec(req.url ?? "");
    if (legal) {
      res.writeHead(301, { Location: (legal[1] === "privacy-policy" ? "/privacy" : "/terms") + (legal[2] ?? ""), "Cache-Control": "public, max-age=86400" }).end();
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
    // Unsupported-browser gate (below the last-2-majors floor, by engine version): a static blocking page for page
    // navigations only. Wrapper apps, /download, legal pages, APIs and assets are never gated.
    if ((req.method === "GET" || req.method === "HEAD") && /text\/html/.test(String(req.headers.accept ?? ""))) {
      const p = (req.url ?? "/").split("?")[0];
      const ua = String(req.headers["user-agent"] ?? "");
      if (!gateExempt(p) && belowFloor(ua)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Vary: "User-Agent" }).end(req.method === "HEAD" ? undefined : unsupportedPageHtml(ua));
        return;
      }
    }
    // Short link for the Android APK download (302 so the target can change via ANDROID_DOWNLOAD_URL).
    if (req.method === "GET" || req.method === "HEAD") {
      const p = (req.url ?? "").split("?")[0];
      if (p === "/android" || p === "/android/") {
        const target = process.env.ANDROID_DOWNLOAD_URL || "https://i.diawi.com/drKdz2";
        res.writeHead(302, { Location: target, "Cache-Control": "no-store" }).end();
        return;
      }
    }
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
    // sticker library: assets, catalog API, PayPal webhook, Apple Pay domain file (server/stickers/api.ts)
    if (isStickerRoute(req.url ?? "")) {
      if ((req.url ?? "").startsWith("/api/") && limited(req, res, "api")) return;
      void handleStickerRoute(req, res);
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
    if (isApiRequest(req.url ?? "")) {
      // per-IP HTTP rate limits (hardening) in front of every API / auth route except the health check
      const u = (req.url ?? "").split("?")[0];
      // signed media file URLs (images in a scrolling chat, video range requests) are exempt; uploads get their own bucket
      if (u !== "/api/health" && !isMediaFileRequest(u) && limited(req, res, u.includes("/auth/") ? "auth" : u === "/api/livekit/token" ? "livekit" : u.startsWith("/api/media/") ? "media" : "api")) return;
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
      !urlPath.startsWith("/emoji/") && // animated emoji: immutable (next.config headers), versioned folder
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
  media.attachHub(hub);

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
  media: new RateLimiter(Number(process.env.RL_MEDIA_PER_MIN || 1200), 60_000),
};
function limited(req: IncomingMessage, res: ServerResponse, bucket: keyof typeof limits) {
  const ip = clientIp(req);
  if (limits[bucket].take(ip)) return false;
  metrics.inc(`http_rate_limited_${bucket}_total`);
  sendJson(res, 429, { ok: false, reason: "rate_limited", error: "Too many requests" }, { "Retry-After": String(limits[bucket].retryAfter(ip)) });
  return true;
}

const bearer = (req: IncomingMessage) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();

main().catch((err) => {
  log.error("boot failed", { err });
  process.exit(1);
});
