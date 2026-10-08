// GET /hx/search?q=<words #tags @handles>&scope=chat|messages|all&chat=<peer or group id>&from=<user id>&before=<at:id>
//   → { ok, query, messages, total, next, rooms, people, profiles }
// Signed-in only, rate-limited; results are scoped to the caller's own conversations (server/chatSearch.ts).
import { parseCursor, search } from "../../../../server/chatSearch";
import { json, limiter, whoAmI } from "../../../../server/routeAuth";
import { isEmptyQuery, parseSearchQuery } from "../../../lib/searchQuery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const allow = limiter("hxSearch", 120);
const ID = /^[\w|.:-]{1,100}$/;

export async function GET(req: Request) {
  const me = await whoAmI(req);
  if (!me) return json(401, { ok: false, reason: "signed_out" });
  if (!allow(me)) return json(429, { ok: false, reason: "rate_limited" });
  const sp = new URL(req.url).searchParams;
  const query = parseSearchQuery(sp.get("q") ?? "");
  const scopeRaw = sp.get("scope");
  const scope = scopeRaw === "chat" || scopeRaw === "messages" ? scopeRaw : "all";
  const chat = sp.get("chat") || null;
  const from = sp.get("from") || null;
  if ((chat && !ID.test(chat)) || (from && !ID.test(from))) return json(400, { ok: false, reason: "bad_id" });
  if (scope === "chat" && !chat) return json(400, { ok: false, reason: "no_chat" });
  if (isEmptyQuery(query) && !(scope === "chat" && from)) return json(400, { ok: false, reason: "empty" });
  const limit = Number(sp.get("limit")) || 30;
  try {
    const r = await search(me, query, { scope, chat, from, before: parseCursor(sp.get("before")), limit });
    return json(200, { ok: true, query, ...r }, "private, no-store");
  } catch (e) {
    console.warn("[hx] search failed", (e as Error).message);
    return json(503, { ok: false, reason: "unavailable" });
  }
}
