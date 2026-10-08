// POST /csp-report: sink for CSP (report-only) violation reports, so the policy has a report-uri (WebKit warns
// "delivered in report-only mode, but does not specify a 'report-uri'" otherwise). Logs a short, sampled line;
// stores nothing. 16 KB cap, per-IP limit.
import { limiter } from "../../../server/routeAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const allow = limiter("cspReport", 30);

export async function POST(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  if (allow(ip)) {
    try {
      const text = (await req.text()).slice(0, 16_384);
      const j = JSON.parse(text) as Record<string, Record<string, unknown>>;
      const r = j["csp-report"] ?? j;
      const dir = String(r["violated-directive"] ?? r["effective-directive"] ?? r.effectiveDirective ?? "?").slice(0, 60);
      const blocked = String(r["blocked-uri"] ?? r.blockedURL ?? "?").replace(/[?#].*$/, "").slice(0, 120);
      if (Math.random() < 0.2) console.warn(`[csp] ${dir} blocked ${blocked}`);
    } catch {
      /* malformed: ignore */
    }
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
