// GET /lp/preview?url=<https url> → { ok, preview } for chat link cards. Signed-in users only (Bearer access token,
// validated by the app's own /api/auth/validate), 60/min per user. All fetching is SSRF-pinned in server/linkPreview.ts,
// and the recipient's device never contacts the linked site (images are proxied through /lp/img).
import { allowUser, getPreview } from "../../../../server/linkPreview";
import { json, whoAmI } from "../../../../server/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await whoAmI(req);
  if (!user) return json(401, { ok: false, reason: "signed_out" });
  if (!allowUser(user)) return json(429, { ok: false, reason: "rate_limited" });
  const url = new URL(req.url).searchParams.get("url") ?? "";
  if (!url || url.length > 2048) return json(400, { ok: false });
  const preview = await getPreview(url);
  return json(200, { ok: true, preview }, "private, max-age=600");
}
