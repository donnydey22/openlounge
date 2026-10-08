// GET /hx/suggest?q=%23mu → { ok, tags }   (my chats weighted, newest first)
// GET /hx/suggest?q=%40ma → { ok, people } (people I follow, then people I chat with, then everyone; blocks hidden)
import { suggestPeople, suggestTags } from "../../../../server/chatSearch";
import { json, limiter, whoAmI } from "../../../../server/routeAuth";
import { normalizeTag } from "../../../lib/linkify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const allow = limiter("hxSuggest", 240);

export async function GET(req: Request) {
  const me = await whoAmI(req);
  if (!me) return json(401, { ok: false, reason: "signed_out" });
  if (!allow(me)) return json(429, { ok: false, reason: "rate_limited" });
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 66);
  try {
    if (q.startsWith("@")) {
      const pre = q.slice(1);
      if (pre && !/^[\p{L}\p{N}_ .'-]{1,40}$/u.test(pre)) return json(200, { ok: true, people: [] });
      return json(200, { ok: true, people: await suggestPeople(me, pre) }, "private, max-age=15");
    }
    return json(200, { ok: true, tags: await suggestTags(me, normalizeTag(q)) }, "private, max-age=30");
  } catch (e) {
    console.warn("[hx] suggest failed", (e as Error).message);
    return json(503, { ok: false, reason: "unavailable" });
  }
}
