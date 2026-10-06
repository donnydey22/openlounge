// Custom Node server: Next.js app + raw WebSocket endpoint (/ws) + small HTTP API on one port.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import next from "next";
import { WsHub } from "./ws";
import { createJoinToken, livekit } from "./livekit";
import { registerRealtime } from "./realtime";
import { store } from "./store";
import fs from "node:fs";

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
    if (req.url?.startsWith("/api/")) {
      void api(req, res);
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
  registerRealtime(new WsHub(server, "/ws"));

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

async function api(req: IncomingMessage, res: ServerResponse) {
  const url = (req.url ?? "").split("?")[0];
  if (url === "/api/health") return json(res, 200, { ok: true, service: "openlounge", audio: livekit.enabled ? "livekit" : "disabled", storage: store.storageKind });

  // LiveKit join token: Authorization: Bearer <session token>, body { roomId }
  if (url === "/api/livekit/token" && req.method === "POST") {
    if (!livekit.enabled) return json(res, 503, { ok: false, configured: false, error: "Live audio isn't configured on this server" });
    const auth = req.headers.authorization ?? "";
    const userId = store.resolveSession(auth.replace(/^Bearer\s+/i, ""));
    if (!userId) return json(res, 401, { ok: false, error: "Not signed in" });
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
  json(res, 404, { ok: false, error: "Not found" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
