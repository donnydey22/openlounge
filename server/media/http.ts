// HTTP routes for the media pipeline (all under /api/media/*; dispatched from server/http.ts).
import type { IncomingMessage, ServerResponse } from "node:http";
import { store } from "../store";
import { readJsonBody } from "../httpsec";
import { log } from "../log";
import { media } from "./service";
import { MediaError } from "./process";

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};
const bearer = (req: IncomingMessage) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();

export const isMediaFileRequest = (path: string) => path.startsWith("/api/media/f/") || path.startsWith("/media/");

export async function handleMediaApi(req: IncomingMessage, res: ServerResponse, url: string) {
  await media.ready();
  const q = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  try {
    // signed file URLs: no bearer (an <img>/<video> can't send one) — the signature is viewer-bound and short-lived
    const f = /^\/api\/media\/f\/([^/]+)\/([^/]+)$/.exec(url);
    if (f && (req.method === "GET" || req.method === "HEAD")) return await media.serve(req, res, f[1], f[2], q);

    const auth = await store.authenticate(bearer(req));
    if (!auth.ok) return json(res, 401, { ok: false, reason: auth.reason, error: "Not signed in" });
    const uid = auth.userId;
    const body = async (limit = 32_768) => ((await readJsonBody(req, limit)) ?? {}) as Record<string, unknown>;

    if (url === "/api/media/uploads" && req.method === "POST") return json(res, 200, { ok: true, ...media.createUpload(uid, await body()) });
    const up = /^\/api\/media\/uploads\/([A-Za-z0-9_-]+)(\/complete)?$/.exec(url);
    if (up && !up[2]) {
      if (req.method === "PUT" || req.method === "PATCH") {
        const r = await media.putChunk(uid, up[1], Number(q.get("offset")), req);
        return json(res, r.status, r.body);
      }
      if (req.method === "GET") return json(res, 200, { ok: true, ...media.uploadStatus(uid, up[1]) });
      if (req.method === "DELETE") return json(res, 200, { ok: true, ...media.cancelUpload(uid, up[1]) });
    }
    if (up && up[2] && req.method === "POST") {
      const r = await media.complete(uid, up[1]);
      return json(res, r.status, r.body);
    }
    if (url === "/api/media/send" && req.method === "POST") {
      const r = media.send(uid, await body());
      return json(res, r.ok ? 200 : 400, r);
    }
    if (url === "/api/media/forward" && req.method === "POST") {
      const { forwardMessage } = await import("../forward");
      const r = await forwardMessage(uid, await body());
      return json(res, r.ok ? 200 : 400, r);
    }
    if (url === "/api/media/usage" && req.method === "GET") return json(res, 200, { ok: true, ...media.usage(uid) });
    if (url === "/api/media/sign" && req.method === "POST") return json(res, 200, { ok: true, ...media.sign(uid, (await body(65_536)).items) });
    if (url === "/api/media/reconcile" && req.method === "POST") return json(res, 200, { ok: true, ...media.reconcile(uid, (await body(65_536)).messageIds) });
    const act = /^\/api\/media\/([A-Za-z0-9_-]+)\/(open|viewed|played|delete)$/.exec(url);
    if (act && req.method === "POST") {
      const [, id, what] = act;
      if (what === "open") return json(res, 200, { ok: true, ...(await media.open(uid, id)) });
      if (what === "viewed") return json(res, 200, await media.viewed(uid, id));
      if (what === "played") return json(res, 200, await media.played(uid, id));
      return json(res, 200, await media.deleteNow(uid, id, { all: ((await body().catch(() => ({}))) as Record<string, unknown>).all === true }));
    }
    if (url === "/api/media/config" && req.method === "GET") {
      const { MEDIA_LIMITS } = await import("../../src/lib/media/types");
      return json(res, 200, { ok: true, limits: MEDIA_LIMITS, video: media.ffmpeg, voice: media.ffmpeg });
    }
    return json(res, 404, { ok: false, error: "Not found" });
  } catch (e) {
    if (e instanceof MediaError) return json(res, e.status, { ok: false, error: e.message });
    const status = (e as { status?: number })?.status;
    if (status === 413 || status === 400) return json(res, status, { ok: false, error: (e as Error).message });
    log.error("media api failed", { path: url, err: e });
    if (!res.headersSent) json(res, 500, { ok: false, error: "Something went wrong with that upload. Try again." });
    else res.destroy();
  }
}
