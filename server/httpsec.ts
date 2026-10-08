// HTTP hardening helpers for the custom server: security headers (HSTS, CSP, …), www → apex redirect,
// request ids, body size limits and a small fixed-window rate limiter. Pure functions where possible (unit tested).
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

const hostOf = (u: string | undefined) => {
  try {
    return u ? new URL(u.replace(/^ws/, "http")).host : "";
  } catch {
    return "";
  }
};

/**
 * Content-Security-Policy. Next.js (no nonce plumbing in the custom server) needs 'unsafe-inline' for its inline
 * bootstrap scripts; dev additionally needs 'unsafe-eval' (React Refresh) and ws: for HMR.
 * Allows: our own /ws (same origin, ws/wss), LiveKit (self-hosted LIVEKIT_URL + LIVEKIT_CLOUD_URL fallback, wss+https),
 * Firebase (gstatic, googleapis, recaptcha, firebaseapp) and OAuth form posts (Google / Apple).
 */
export function buildCsp(env: Record<string, string | undefined> = process.env, dev = env.NODE_ENV !== "production") {
  const lk = [env.LIVEKIT_URL, env.LIVEKIT_CLOUD_URL, env.NEXT_PUBLIC_WS_URL].map(hostOf).filter(Boolean);
  const lkConnect = lk.flatMap((h) => [`wss://${h}`, `https://${h}`]);
  const extra = (env.CSP_EXTRA_CONNECT ?? "").split(/[\s,]+/).filter(Boolean);
  const d: Record<string, string[]> = {
    "default-src": ["'self'"],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "form-action": ["'self'", "https://accounts.google.com", "https://appleid.apple.com"],
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : []), "https://www.gstatic.com", "https://apis.google.com", "https://www.google.com/recaptcha/", "https://www.recaptcha.net", "https://accounts.google.com", "https://appleid.cdn-apple.com"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https://www.gstatic.com", "https://*.googleusercontent.com"],
    "font-src": ["'self'", "data:"],
    "media-src": ["'self'", "blob:"],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "connect-src": [
      "'self'",
      // same-origin WebSocket (/ws): 'self' covers ws(s) same-host in modern browsers; explicit for older WebViews
      ...(env.PUBLIC_HOST ? [`wss://${env.PUBLIC_HOST}`] : ["wss://openlounge.app"]),
      ...(dev ? ["ws:", "http://localhost:*", "ws://localhost:*"] : []),
      ...lkConnect,
      "https://*.googleapis.com",
      "https://www.google.com/recaptcha/",
      "https://*.firebaseapp.com",
      "https://*.firebaseio.com",
      "wss://*.firebaseio.com",
      "https://accounts.google.com",
      "https://appleid.apple.com",
      ...extra,
    ],
    "frame-src": ["https://*.firebaseapp.com", "https://accounts.google.com", "https://appleid.apple.com", "https://www.google.com/recaptcha/", "https://recaptcha.google.com", "https://www.recaptcha.net"],
  };
  // Paid stickers: PayPal JS SDK + Apple Pay / Google Pay via PayPal (only when the paid flag is on)
  if (/^(1|true|yes)$/i.test(env.STICKERS_PAID_ENABLED ?? "")) {
    d["script-src"].push("https://*.paypal.com", "https://*.paypalobjects.com", "https://applepay.cdn-apple.com", "https://pay.google.com");
    d["connect-src"].push("https://*.paypal.com", "https://*.paypalobjects.com", "https://pay.google.com", "https://google.com");
    d["frame-src"].push("https://*.paypal.com", "https://pay.google.com");
    d["img-src"].push("https://*.paypal.com", "https://*.paypalobjects.com");
  }
  if (!dev) d["upgrade-insecure-requests"] = [];
  if (env.CSP_REPORT_URI) d["report-uri"] = [env.CSP_REPORT_URI];
  return Object.entries(d)
    .map(([k, v]) => [k, ...[...new Set(v)]].join(" "))
    .join("; ");
}

export function securityHeaders(env: Record<string, string | undefined> = process.env, dev = env.NODE_ENV !== "production"): Record<string, string> {
  const h: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": `microphone=(self), camera=(), geolocation=(), payment=${
      // paid stickers: Google Pay / Payment Request (incl. inside PayPal's frames) only when the paid flag is on
      /^(1|true|yes)$/i.test(env.STICKERS_PAID_ENABLED ?? "") ? '(self "https://pay.google.com" "https://www.paypal.com" "https://www.sandbox.paypal.com")' : "()"
    }, usb=(), interest-cohort=()`,
    "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
  };
  // HSTS only over TLS in production (Railway terminates TLS; localhost must stay http). 1 year, no preload yet.
  if (!dev && env.HSTS !== "0") h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  if (env.CSP !== "0") h[env.CSP_REPORT_ONLY === "1" ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy"] = buildCsp(env, dev);
  return h;
}

/** www.<apex> → https://<apex><path> (308 keeps method/body). Returns the target URL or null. */
export function wwwRedirect(host: string | undefined, url: string | undefined, apex = process.env.CANONICAL_HOST || "openlounge.app"): string | null {
  const h = (host ?? "").toLowerCase().replace(/:\d+$/, "");
  if (h !== `www.${apex}`) return null;
  const path = url && url.startsWith("/") && !url.startsWith("//") ? url : "/";
  return `https://${apex}${path}`;
}

export function requestId(req: IncomingMessage): string {
  const incoming = req.headers["x-request-id"];
  const v = Array.isArray(incoming) ? incoming[0] : incoming;
  return v && /^[\w.:-]{6,128}$/.test(v) ? v : randomUUID();
}

export class BodyTooLarge extends Error {
  status = 413;
}
export class BadJson extends Error {
  status = 400;
}

/** Read a JSON object body with a hard byte cap (default 16 KB). Throws BodyTooLarge / BadJson. */
export async function readJsonBody(req: IncomingMessage, limit = 16_384): Promise<Record<string, unknown>> {
  const len = Number(req.headers["content-length"] || 0);
  if (len > limit) throw new BodyTooLarge("body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new BodyTooLarge("body too large");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new BadJson("expected a JSON object");
    return v;
  } catch (e) {
    if (e instanceof BadJson) throw e;
    throw new BadJson("invalid JSON");
  }
}

/** Fixed-window limiter keyed by string (IP, user, conn). Memory bounded by periodic sweep. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {
    const t = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    }, Math.max(windowMs, 10_000));
    t.unref();
  }
  /** true = allowed */
  take(key: string, now = Date.now()): boolean {
    const e = this.hits.get(key);
    if (!e || e.reset <= now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    return ++e.n <= this.limit;
  }
  retryAfter(key: string, now = Date.now()) {
    const e = this.hits.get(key);
    return e ? Math.max(1, Math.ceil((e.reset - now) / 1000)) : 1;
  }
}

/** Client IP: Railway's edge sets X-Forwarded-For (first hop = client). */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}
