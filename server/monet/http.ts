// Shared HTTP helpers for the monetization routes (mounted through server/stickers/api.ts, so server/index.ts and
// server/http.ts stay untouched).
import type { IncomingMessage, ServerResponse } from "node:http";
import { store } from "../store";
import { readJsonBody } from "../httpsec";

export const json = (res: ServerResponse, status: number, body: unknown, cache = "no-store") => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache });
  res.end(JSON.stringify(body));
};
export const bearer = (req: IncomingMessage) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
/** the phone apps (WebView wrappers) — never sell anything inside them (App Store 3.1.1 / Play Payments) */
export const isWrapper = (req: IncomingMessage) => /OpenLounge(Android|iOS)/i.test(String(req.headers["user-agent"] ?? ""));
export async function authUser(req: IncomingMessage): Promise<string | null> {
  const a = await store.authenticate(bearer(req));
  return a.ok ? a.userId : null;
}
export const body = (req: IncomingMessage, limit = 32_768) => (req.method === "POST" ? readJsonBody(req, limit) : Promise.resolve({} as Record<string, unknown>));
export type Out = { ok: boolean; status?: number; error?: string } & Record<string, unknown>;
export function send(res: ServerResponse, r: Out) {
  if (!r.ok) return json(res, r.status ?? 400, { ok: false, error: r.error });
  const { status: _s, ...rest } = r;
  void _s;
  return json(res, 200, rest);
}
export const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
export const httpsUrl = (v: unknown, max = 400) => {
  const s = str(v, max);
  if (!s) return "";
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u.toString() : "";
  } catch {
    return "";
  }
};
