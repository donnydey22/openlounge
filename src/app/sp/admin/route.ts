// Admin API for sponsored messages (admins only: server/moderation isAdmin).
// GET → { enabled, ads }. POST { op: "switch", enabled } | { op: "create", ad } | { op: "update", id, ad } | { op: "delete", id }.
import { isAdmin } from "../../../../server/moderation";
import { json, limiter, whoAmI } from "../../../../server/routeAuth";
import { encodeImage, newAdId, store, toPublic, validate, type AdInput } from "../../../../server/sponsored";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const allow = limiter("spAdmin", 60);

async function admin(req: Request) {
  const me = await whoAmI(req);
  if (!me) return { err: json(401, { ok: false, reason: "signed_out" }) };
  if (!isAdmin(me)) return { err: json(403, { ok: false, reason: "admins_only" }) };
  if (!allow(me)) return { err: json(429, { ok: false, reason: "rate_limited" }) };
  return { me };
}

async function listing() {
  const s = store();
  return { ok: true, enabled: await s.getEnabled(), ads: (await s.list()).map(toPublic), now: Date.now() };
}

export async function GET(req: Request) {
  const a = await admin(req);
  if (a.err) return a.err;
  try {
    return json(200, await listing());
  } catch (e) {
    console.warn("[sp] admin list failed", (e as Error).message);
    return json(503, { ok: false, error: "Storage unavailable" });
  }
}

export async function POST(req: Request) {
  const a = await admin(req);
  if (a.err) return a.err;
  const text = await req.text();
  if (text.length > 12 * 1024 * 1024) return json(413, { ok: false, error: "Images too large (max ~6 MB each)" });
  let b: { op?: string; id?: string; enabled?: boolean; ad?: AdInput };
  try {
    b = JSON.parse(text);
  } catch {
    return json(400, { ok: false });
  }
  const s = store();
  try {
    if (b.op === "switch") {
      await s.setEnabled(!!b.enabled);
      console.log(`[sp] master switch ${b.enabled ? "on" : "off"} by ${a.me}`);
      return json(200, await listing());
    }
    if (b.op === "delete") {
      if (!b.id || !(await s.get(b.id))) return json(404, { ok: false, error: "Not found" });
      await s.remove(b.id);
      return json(200, await listing());
    }
    if (b.op === "create" || b.op === "update") {
      const id = b.op === "create" ? newAdId() : String(b.id ?? "");
      if (b.op === "update" && !(await s.get(id))) return json(404, { ok: false, error: "Not found" });
      const v = validate(b.ad ?? {}, b.op === "update");
      if (!v.ok) return json(400, { ok: false, error: v.error });
      const { avatarData, imageData, ...fields } = v.v;
      const extra: { avatar?: Buffer | null; image?: { data: Buffer; w: number; h: number } | null } = {};
      if (avatarData !== undefined) {
        if (avatarData === null) extra.avatar = null;
        else {
          const img = await encodeImage(avatarData, 256);
          if (!img) return json(400, { ok: false, error: "Couldn't read the avatar image (PNG, JPEG, WebP or GIF, ≤ 6 MB)" });
          extra.avatar = img.data;
        }
      }
      if (imageData !== undefined) {
        if (imageData === null) extra.image = null;
        else {
          const img = await encodeImage(imageData, 1080);
          if (!img) return json(400, { ok: false, error: "Couldn't read the image (PNG, JPEG, WebP or GIF, ≤ 6 MB)" });
          extra.image = img;
        }
      }
      if (b.op === "create") delete fields.enabled; // new ads always start disabled
      await s.upsert(id, { ...fields, ...extra }, a.me!);
      return json(200, { ...(await listing()), id });
    }
    return json(400, { ok: false });
  } catch (e) {
    console.warn("[sp] admin op failed", (e as Error).message);
    return json(503, { ok: false, error: "Storage unavailable" });
  }
}
