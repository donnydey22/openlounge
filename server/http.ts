// HTTP API (everything under /api/* and /auth/*), shared by server/index.ts and the in-process tests.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createJoinToken, livekit } from "./livekit";
import { store } from "./store";
import { readJsonBody } from "./httpsec";
import { firebasePhoneLogin } from "./realtime";
import { push } from "./push";
import { deviceLabel, originAllowed } from "./auth";
import { UNIFIED_AUTH_PATH, handleAuthApi, handleNavigation, isNavigationRoute } from "./authx/routes";

/** Requests answered by api() instead of Next.js. */
export function isApiRequest(url: string) {
  const path = url.split("?")[0];
  return path.startsWith("/api/") || /^\/auth\/(validate|refresh|logout)$/.test(path) || UNIFIED_AUTH_PATH.test(path);
}

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** JSON body (hardening): 16 KB default (HTTP_MAX_BODY_BYTES), 413 above, 400 on malformed JSON (caught in index.ts). */
const readJson = (req: IncomingMessage, limit = Number(process.env.HTTP_MAX_BODY_BYTES || 16_384)) => readJsonBody(req, limit);

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

export async function api(req: IncomingMessage, res: ServerResponse) {
  const url = (req.url ?? "").split("?")[0];
  // OAuth start/callback are top-level browser navigations (Apple's form_post comes from appleid.apple.com):
  // they answer with redirects and are protected by the sealed state cookie, not by CORS.
  if (isNavigationRoute(url)) return handleNavigation(req, res, url, new URLSearchParams((req.url ?? "").split("?")[1] ?? ""));
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

  // ---- unified sign-in: providers, Google/Apple exchange, email + password, linking, reset ----
  if (UNIFIED_AUTH_PATH.test(url) && (await handleAuthApi(req, res, url))) return;

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
  // Firebase Phone Auth: body { idToken, device } → { status:"existing", access, refresh, … , user } | { status:"new", ticket }
  if (authPath === "/auth/firebase" && req.method === "POST") {
    const body = await readJson(req);
    const r = await firebasePhoneLogin(body.idToken, deviceLabel(body.device, req.headers["user-agent"]));
    if (!r.ok) return json(res, 401, r);
    if (r.status === "new") return json(res, 200, { ok: true, status: "new", ticket: r.ticket });
    return json(res, 200, { ok: true, status: "existing", ...r.creds, user: store.me(r.userId), following: store.followingIds(r.userId), unreadDms: store.unreadDmCount(r.userId) });
  }

  // Public profile card (share links openlounge.app/@handle + Open Graph preview): name, handle, bio, photo, counts only
  const byHandle = url.match(/^\/api\/users\/by-handle\/([A-Za-z0-9_]{1,30})$/);
  if (byHandle && req.method === "GET") {
    const h = byHandle[1].toLowerCase();
    const u = [...store.users.values()].find((x) => !x.isBot && x.username?.toLowerCase() === h);
    const pub = u ? store.publicUser(u.id) : null;
    if (!pub) return json(res, 404, { ok: false, error: "Not found" });
    const { id, name, username, color, photoUrl, bio, followers, following } = pub;
    return json(res, 200, { ok: true, user: { id, name, username, color, photoUrl, bio, followers, following } });
  }

  // ---- push / notification settings / contacts (Authorization: Bearer <access token>) ----
  if (/^\/api\/(push|notifications|contacts)\//.test(url)) {
    const n = push();
    if (!n) return json(res, 503, { ok: false, error: "Notifications unavailable" });
    const auth = await store.authenticate(bearer(req));
    if (!auth.ok) return json(res, 401, { ok: false, reason: auth.reason, error: "Not signed in" });
    const uid = auth.userId;
    if (url === "/api/push/register" && req.method === "POST") {
      const b = await readJson(req);
      const r = await n.registerToken(uid, b.token, b.platform);
      return json(res, r.ok ? 200 : 400, r);
    }
    if (url === "/api/push/unregister" && req.method === "POST") return json(res, 200, await n.unregisterToken(uid, (await readJson(req)).token));
    if (url === "/api/notifications/prefs" && req.method === "GET") return json(res, 200, { ok: true, prefs: await n.getPrefs(uid) });
    if (url === "/api/notifications/prefs" && req.method === "POST") return json(res, 200, { ok: true, prefs: await n.updatePrefs(uid, await readJson(req)) });
    if (url === "/api/contacts/match" && req.method === "POST") {
      const b = await readJson(req, 400_000);
      const r = await n.matchContacts(uid, b.hashes);
      if (!r.ok) return json(res, 400, r);
      return json(res, 200, { ok: true, users: r.userIds.map((id) => store.publicUser(id)).filter(Boolean), matchedHashes: r.matchedHashes, following: store.followingIds(uid) });
    }
    if (url === "/api/contacts/delete" && req.method === "POST") {
      await n.updatePrefs(uid, { contactsOptIn: false });
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { ok: false, error: "Not found" });
  }

  // Account deletion: Authorization: Bearer <access token>, body { confirm: "DELETE" }. Irreversible.
  if (url === "/api/me/delete" && (req.method === "POST" || req.method === "DELETE")) {
    const auth = await store.authenticate(bearer(req));
    if (!auth.ok) return json(res, 401, { ok: false, reason: auth.reason, error: "Not signed in" });
    const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
    if (body?.confirm !== "DELETE") return json(res, 400, { ok: false, error: 'Confirmation required: send { "confirm": "DELETE" }' });
    const n = push();
    if (n) await n.deleteUserData(auth.userId);
    const r = store.deleteAccount(auth.userId);
    if (!r.ok) return json(res, r.status, { ok: false, error: r.error });
    await store.flush().catch(() => {});
    return json(res, 200, { ok: true });
  }

  // Social links: Authorization: Bearer <access token>, body { links: { instagram?: string|null, ... } }
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

