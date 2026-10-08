// Bearer-token → user id for Next route handlers (/lp/*, /hx/*) that live outside server/http.ts. Validates through the
// app's own /api/auth/validate (same token rules, revocation and rate limits as every other API call) and caches the
// answer per token hash for a few minutes, so a chat full of link cards / a burst of search keystrokes costs one check.
import { createHash } from "node:crypto";

const G = globalThis as unknown as { __olRouteAuth?: Map<string, { uid: string; exp: number }> };
const seen = (G.__olRouteAuth ??= new Map());
const TTL = 5 * 60_000;

export async function whoAmI(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization");
  const xff = req.headers.get("x-forwarded-for");
  if (!auth || auth.length > 4096 || !/^Bearer\s+\S+$/i.test(auth)) return null;
  const key = createHash("sha256").update(auth).digest("base64url");
  const hit = seen.get(key);
  if (hit && hit.exp > Date.now()) return hit.uid;
  try {
    const headers: Record<string, string> = { Authorization: auth };
    if (xff) headers["X-Forwarded-For"] = xff; // keep the per-client rate limit per client, not per localhost
    const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/auth/validate`, { headers, cache: "no-store", signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = (await r.json()) as { user?: { id?: string } };
    const uid = j.user?.id;
    if (!uid) return null;
    if (seen.size > 5000) seen.clear();
    seen.set(key, { uid, exp: Date.now() + TTL });
    return uid;
  } catch {
    return null;
  }
}

export const json = (status: number, body: unknown, cache = "no-store") =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": cache, "X-Content-Type-Options": "nosniff" } });

/** tiny per-key sliding-window limiter */
export function limiter(name: string, perMin: number) {
  const g = globalThis as unknown as Record<string, Map<string, number[]> | undefined>;
  const k = `__olRl_${name}`;
  const m = (g[k] ??= new Map());
  return (id: string) => {
    const now = Date.now();
    const arr = (m.get(id) ?? []).filter((t: number) => now - t < 60_000);
    if (arr.length >= perMin) return false;
    arr.push(now);
    m.set(id, arr);
    if (m.size > 10000) m.clear();
    return true;
  };
}
