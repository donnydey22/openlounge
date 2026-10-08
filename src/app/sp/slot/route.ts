// GET /sp/slot?placement=rooms | ?placement=groups&chat=g_… → { ok, ad } (at most one sponsored message per view).
// Never for 1:1 DMs: the groups placement only accepts group ids and the viewer must be a member.
import { chatMembers } from "../../../../server/chatSearch";
import { json, limiter, whoAmI } from "../../../../server/routeAuth";
import { pickAd } from "../../../../server/sponsored";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const allow = limiter("spSlot", 60);

export async function GET(req: Request) {
  const me = await whoAmI(req);
  if (!me) return json(401, { ok: false, reason: "signed_out" });
  if (!allow(me)) return json(429, { ok: false, reason: "rate_limited" });
  const sp = new URL(req.url).searchParams;
  const placement = sp.get("placement");
  try {
    if (placement === "rooms") return json(200, { ok: true, ad: await pickAd(me, "rooms", 0) }, "private, max-age=60");
    if (placement === "groups") {
      const chat = sp.get("chat") ?? "";
      if (!/^g_[\w.:-]{1,96}$/.test(chat)) return json(200, { ok: true, ad: null });
      const members = await chatMembers(me, chat);
      if (!members) return json(200, { ok: true, ad: null });
      return json(200, { ok: true, ad: await pickAd(me, "groups", members.length) }, "private, max-age=60");
    }
    return json(400, { ok: false });
  } catch (e) {
    console.warn("[sp] slot failed", (e as Error).message);
    return json(200, { ok: true, ad: null });
  }
}
