// GET /hx/members?chat=<peer or group id> → { ok, members } for the in-chat search "from:" picker (members only).
import { chatMembers } from "../../../../server/chatSearch";
import { json, limiter, whoAmI } from "../../../../server/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const allow = limiter("hxMembers", 60);

export async function GET(req: Request) {
  const me = await whoAmI(req);
  if (!me) return json(401, { ok: false, reason: "signed_out" });
  if (!allow(me)) return json(429, { ok: false, reason: "rate_limited" });
  const chat = new URL(req.url).searchParams.get("chat") ?? "";
  if (!/^[\w|.:-]{1,100}$/.test(chat)) return json(400, { ok: false });
  try {
    const members = await chatMembers(me, chat);
    if (!members) return json(404, { ok: false, reason: "not_member" });
    return json(200, { ok: true, members }, "private, max-age=60");
  } catch (e) {
    console.warn("[hx] members failed", (e as Error).message);
    return json(503, { ok: false, reason: "unavailable" });
  }
}
