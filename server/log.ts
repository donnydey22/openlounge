// Structured JSON logging (one line per event) + tiny in-process metrics.
// LOG_FORMAT=pretty for human-readable dev output; LOG_LEVEL=debug|info|warn|error (default info).
import { AsyncLocalStorage } from "node:async_hooks";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = ORDER[(process.env.LOG_LEVEL as Level) || "info"] ?? 20;
const pretty = process.env.LOG_FORMAT === "pretty";

/** per-request context (request id) propagated through async calls */
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

function errFields(v: unknown) {
  if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack?.split("\n").slice(0, 8).join("\n"), code: (v as { code?: unknown }).code };
  return v;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < min) return;
  const ctx = requestContext.getStore();
  const rec: Record<string, unknown> = { ts: new Date().toISOString(), level, msg, ...(ctx ? { requestId: ctx.requestId } : {}) };
  if (fields) for (const [k, v] of Object.entries(fields)) rec[k] = k === "err" || v instanceof Error ? errFields(v) : v;
  const line = pretty ? `${rec.ts} ${level.toUpperCase()} ${msg}${fields ? " " + JSON.stringify(fields, (_k, v) => (v instanceof Error ? errFields(v) : v)) : ""}` : safeJson(rec);
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "unserializable log record" });
  }
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write("error", msg, f),
};

// ---------- metrics (counters + gauges), exposed at /metrics (Prometheus text) when METRICS_TOKEN matches ----------
const counters = new Map<string, number>();
const gauges = new Map<string, () => number>();
export const metrics = {
  inc(name: string, by = 1) {
    counters.set(name, (counters.get(name) ?? 0) + by);
  },
  gauge(name: string, fn: () => number) {
    gauges.set(name, fn);
  },
  snapshot() {
    const out: Record<string, number> = {};
    for (const [k, v] of counters) out[k] = v;
    for (const [k, fn] of gauges) {
      try {
        out[k] = fn();
      } catch {
        /* ignore */
      }
    }
    return out;
  },
  prometheus() {
    return Object.entries(this.snapshot())
      .map(([k, v]) => `openlounge_${k.replace(/[^a-zA-Z0-9_]/g, "_")} ${v}`)
      .join("\n") + "\n";
  },
};
