// GET /sp/img/<id>-<a|i>-<version>.jpg → advertiser avatar / creative, re-encoded JPEG served from our origin
// (no third-party requests from viewers). Versioned URL → immutable caching.
import { store } from "../../../../../server/sponsored";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const m = name.match(/^(sp_[\w-]{4,40})-([ai])-(\d{1,9})\.jpg$/);
  if (!m) return new Response(null, { status: 404 });
  try {
    const buf = await store().img(m[1], m[2] as "a" | "i");
    if (!buf) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(buf), {
      headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
    });
  } catch {
    return new Response(null, { status: 503 });
  }
}
