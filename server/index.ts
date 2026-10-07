// Custom Node server: Next.js app + raw WebSocket endpoint (/ws) + small HTTP API on one port.
import { createServer } from "node:http";
import next from "next";
import { WsHub } from "./ws";
import { livekit } from "./livekit";
import { registerRealtime } from "./realtime";
import { store } from "./store";
import fs from "node:fs";
import { originAllowed } from "./auth";
import { api, isApiRequest, json } from "./http";
import { logProviderStatus } from "./authx/providers";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOST || "0.0.0.0";

async function main() {
  // Durable storage first (Postgres via DATABASE_URL, else db.json) — fail fast before serving anything
  await store.init();
  logProviderStatus();

  const app = next({ dev, hostname: "localhost", port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const server = createServer((req, res) => {
    // Short link for the Android APK download (302 so the target can change via ANDROID_DOWNLOAD_URL).
    if (req.method === "GET" || req.method === "HEAD") {
      const p = (req.url ?? "").split("?")[0];
      if (p === "/android" || p === "/android/") {
        const target = process.env.ANDROID_DOWNLOAD_URL || "https://i.diawi.com/drKdz2";
        res.writeHead(302, { Location: target, "Cache-Control": "no-store" }).end();
        return;
      }
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
