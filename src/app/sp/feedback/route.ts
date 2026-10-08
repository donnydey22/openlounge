// POST /sp/feedback { id, action: "hide" | "report", reason? } → hides the sponsored message for this user
// (reports also hide it and are queued for admins). No other per-user data is stored.
import { json, limiter, whoAmI } from "../../../../server/routeAuth";
import { REPORT_REASONS, store } from "../../../../server/sponsored";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const allow = limiter("spFeedback", 20);

export async function POST(req: Request) {
  const me = await whoAmI(req);
  if (!me) return json(401, { ok: false, reason: "signed_out" });
  if (!allow(me)) return json(429, { ok: false, reason: "rate_limited" });
  let b: { id?: unknown; action?: unknown; reason?: unknown };
  try {
    b = JSON.parse((await req.text()).slice(0, 2000));
  } catch {
    return json(400, { ok: false });
  }
  const id = String(b.id ?? "");
  if (!/^sp_[\w-]{4,40}$/.test(id)) return json(400, { ok: false });
  try {
    const s = store();
    if (!(await s.get(id))) return json(404, { ok: false });
    if (b.action === "hide") await s.hide(me, id);
    else if (b.action === "report") {
      const reason = (REPORT_REASONS as readonly string[]).includes(String(b.reason)) ? String(b.reason) : "other";
      await s.report(me, id, reason);
    } else return json(400, { ok: false });
    return json(200, { ok: true });
  } catch (e) {
    console.warn("[sp] feedback failed", (e as Error).message);
    return json(503, { ok: false });
  }
}
