// Device → server endpoints for the native ring UIs (NATIVE_SPEC.md §2). Authenticated with the app's session bearer.
//   GET  /api/calls/<id>               → { ok, call: { id, phase, outcome?, video, callerId, calleeId } } (is it still ringing?)
//   POST /api/calls/<id>/decline       → decline from the notification / CallKit without loading the web app
//        (or, with no session: header X-Call-Decline-Token / body {declineToken} = the per-call token from the ring push)
//   POST /api/push/voip-token          { token, env? }  iOS PushKit token (build 18); env "sandbox" for dev builds
//   POST /api/push/voip-token/remove   { token }
import type { IncomingMessage, ServerResponse } from "node:http";
import { calls } from "./index";
import { voipService } from "./voip";
import { DECLINE_TOKEN_HEADER, declineTokens } from "./declineToken";

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

/**
 * Session-less decline with the per-call token from the ring push (server/calls/declineToken.ts). Runs BEFORE the
 * session check in http.ts. Returns false (not handled) when no token was supplied, or when the token failed but the
 * request also carries a bearer session, so the normal session path can still decline.
 *   200 {ok, phase}  declined (or the call had already ended)
 *   401 {reason: malformed|signature|expired|wrong_call}   403 {reason: wrong_user}   404 {reason: unknown}
 *   409 {reason: replayed|answered}. Wrappers treat any non-2xx as "done" and dismiss the ring UI.
 */
export async function handleTokenDecline(req: IncomingMessage, res: ServerResponse, url: string, hasBearer: boolean, json: Json, readJson: ReadJson) {
  const m = url.match(/^\/api\/calls\/([A-Za-z0-9_-]{1,64})\/decline$/);
  if (!m || req.method !== "POST") return false;
  let token = req.headers[DECLINE_TOKEN_HEADER];
  if (Array.isArray(token)) token = token[0];
  if (!token && !hasBearer) token = String((await readJson(req).catch(() => ({}) as Record<string, unknown>)).declineToken ?? "");
  if (!token) return false;
  const callId = m[1];
  if (!allow(`decline-token:${callId}`, 10)) return json(res, 429, { ok: false, error: "Too many requests" }), true;
  const tokens = declineTokens();
  const fail = (status: number, reason: string) => {
    if (hasBearer) return false; // let the session path try
    json(res, status, { ok: false, reason, error: "Couldn't decline" });
    return true;
  };
  const v = tokens.inspect(token, callId);
  if (!v.ok) return fail(v.reason === "replayed" ? 409 : 401, v.reason);
  const s = calls();
  if (!s) return json(res, 503, { ok: false, error: "Unavailable" }), true;
  const c = s.peek(callId, v.userId);
  if (!c) return fail(404, "unknown"); // unknown/purged call, or the token's user isn't in it
  if (c.calleeId !== v.userId) return fail(403, "wrong_user");
  if (c.phase === "active") return fail(409, "answered");
  if (!tokens.consume(v.nonce!, v.exp!)) return fail(409, "replayed");
  const r = s.decline(callId, v.userId);
  return json(res, r.ok ? 200 : 404, r.ok ? { ok: true, phase: r.call?.phase ?? "ended" } : r), true;
}
