// Device → server endpoints for the native ring UIs (NATIVE_SPEC.md §2). Authenticated with the app's session bearer.
//   GET  /api/calls/<id>               → { ok, call: { id, phase, outcome?, video, callerId, calleeId } } (is it still ringing?)
//   POST /api/calls/<id>/decline       → decline from the notification / CallKit without loading the web app
//   POST /api/push/voip-token          { token, env? }  iOS PushKit token (build 18); env "sandbox" for dev builds
//   POST /api/push/voip-token/remove   { token }
import type { IncomingMessage, ServerResponse } from "node:http";
import { calls } from "./index";
import { voipService } from "./voip";

type Json = (res: ServerResponse, status: number, body: unknown) => void;
type ReadJson = (req: IncomingMessage) => Promise<Record<string, unknown>>;

/** a tiny per-user limiter so a buggy wrapper can't hammer these */
const hits = new Map<string, number[]>();
function allow(uid: string, max = 30, windowMs = 60_000) {
  const now = Date.now();
  const arr = (hits.get(uid) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now);
  hits.set(uid, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  return true;
}

export const isCallsHttpPath = (url: string) => url.startsWith("/api/calls/") || url === "/api/push/voip-token" || url === "/api/push/voip-token/remove";

export async function handleCallsHttp(req: IncomingMessage, res: ServerResponse, url: string, uid: string, json: Json, readJson: ReadJson) {
  if (!allow(uid)) return json(res, 429, { ok: false, error: "Too many requests" });
  if (url === "/api/push/voip-token" || url === "/api/push/voip-token/remove") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });
    const v = voipService();
    if (!v) return json(res, 503, { ok: false, error: "Unavailable" });
    const b = await readJson(req);
    if (url.endsWith("/remove")) return json(res, 200, await v.unregister(uid, b.token));
    const r = await v.register(uid, b.token, b.env);
    return json(res, r.ok ? 200 : 400, r);
  }
  const m = url.match(/^\/api\/calls\/([A-Za-z0-9_-]{1,64})(\/decline)?$/);
  const s = calls();
  if (!m) return json(res, 404, { ok: false, error: "Not found" });
  if (!s) return json(res, 503, { ok: false, error: "Unavailable" });
  const [, callId, decline] = m;
  if (decline) {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "Method not allowed" });
    const r = s.decline(callId, uid);
    return json(res, r.ok ? 200 : 404, r.ok ? { ok: true, phase: r.call?.phase ?? "ended" } : r);
  }
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "Method not allowed" });
  const r = await s.get_(callId, uid);
  if (!r.ok) return json(res, 404, r);
  const c = r.call; // no LiveKit token here: the web layer fetches media itself when it opens /call/<id>
  return json(res, 200, { ok: true, call: { id: c.id, phase: c.phase, outcome: c.outcome ?? null, video: c.video, callerId: c.callerId, calleeId: c.calleeId, expiresAt: c.expiresAt } });
}
