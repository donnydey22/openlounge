// FX-081 per-call telemetry store. Clients send "call:telemetry" every 5 s (one row per RTP stream); the SFU sends
// "ms:gateway:telemetry" (per producer/consumer score, loss, bitrate, preferred layer). Everything is sanitized,
// bounded in memory per call, and logged as one compact line per sample ("[calls] telemetry") so Railway logs carry
// the history; summarize() turns either source into a per-call table (scripts/call-telemetry-summary.ts).
export type TelemetryRow = { src: "client" | "sfu"; user: string; t: number; platform?: string; net?: string; dir: string; kind: string; rid?: string; layer?: string; lossPct: number | null; rttMs: number | null; jitterMs: number | null; kbps: number | null; fps: number | null; freezes: number | null; score?: number | null };

export const TELEMETRY_LIMITS = { rowsPerCall: 2_000, calls: 200, ttlMs: 2 * 60 * 60 * 1000, streamsPerSample: 8 } as const;

const n = (v: unknown, max = 1e7) => (typeof v === "number" && Number.isFinite(v) ? Math.max(-1, Math.min(max, Math.round(v * 10) / 10)) : null);
const str = (v: unknown, len = 24) => (typeof v === "string" ? v.replace(/[^\w:.\-]/g, "").slice(0, len) : undefined);

/** Validate one client/SFU sample into rows; garbage in → [] (never throws). */
export function sanitizeSample(src: "client" | "sfu", user: string, d: unknown, now = Date.now()): TelemetryRow[] {
  if (!d || typeof d !== "object") return [];
  const x = d as Record<string, unknown>;
  const streams = Array.isArray(x.streams) ? x.streams.slice(0, TELEMETRY_LIMITS.streamsPerSample) : [];
  const out: TelemetryRow[] = [];
  for (const s of streams) {
    if (!s || typeof s !== "object") continue;
    const r = s as Record<string, unknown>;
    const dir = str(r.dir, 8), kind = str(r.kind, 8);
    if (!dir || (kind !== "audio" && kind !== "video")) continue;
    out.push({
      src, user: (str(r.user, 12) ?? user).slice(0, 12), t: now, platform: str(x.platform, 12), net: str(x.net, 16), dir, kind,
      ...(str(r.rid, 4) ? { rid: str(r.rid, 4) } : {}), ...(str(r.layer, 8) ? { layer: str(r.layer, 8) } : {}),
      lossPct: n(r.lossPct, 100), rttMs: n(r.rttMs, 60_000), jitterMs: n(r.jitterMs, 60_000), kbps: n(r.kbps, 100_000), fps: n(r.fps, 240), freezes: n(r.freezes, 1e6),
      ...(r.score !== undefined ? { score: n(r.score, 10) } : {}),
    });
  }
  return out;
}

export class CallTelemetryStore {
  private calls = new Map<string, { at: number; rows: TelemetryRow[] }>();
  add(callId: string, rows: TelemetryRow[], now = Date.now()) {
    if (!rows.length || !callId) return;
    let c = this.calls.get(callId);
    if (!c) {
      this.prune(now);
      c = { at: now, rows: [] };
      this.calls.set(callId, c);
    }
    c.at = now;
    c.rows.push(...rows);
    if (c.rows.length > TELEMETRY_LIMITS.rowsPerCall) c.rows.splice(0, c.rows.length - TELEMETRY_LIMITS.rowsPerCall);
  }
  rows(callId: string) { return this.calls.get(callId)?.rows ?? []; }
  summary(callId: string) { return summarize(this.rows(callId)); }
  private prune(now: number) {
    for (const [id, c] of this.calls) if (now - c.at > TELEMETRY_LIMITS.ttlMs) this.calls.delete(id);
    while (this.calls.size >= TELEMETRY_LIMITS.calls) this.calls.delete(this.calls.keys().next().value!);
  }
}

const vals = (rows: TelemetryRow[], k: keyof TelemetryRow) => rows.map((r) => r[k]).filter((v): v is number => typeof v === "number" && v >= 0);
const pct = (a: number[], p: number) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const avg = (a: number[]) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);

/** Per (source, user, direction, kind) stream: samples, loss avg/p95/max, RTT p50/p95, jitter avg/p95, kbps avg, fps min/avg, freezes, bad windows. */
export function summarize(rows: TelemetryRow[]) {
  const groups = new Map<string, TelemetryRow[]>();
  for (const r of rows) {
    const k = `${r.src}|${r.user}|${r.dir}|${r.kind}${r.rid ? "|" + r.rid : ""}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  return [...groups.entries()].map(([k, g]) => {
    const [src, user, dir, kind, rid] = k.split("|");
    const loss = vals(g, "lossPct"), rtt = vals(g, "rttMs"), jit = vals(g, "jitterMs"), fps = vals(g, "fps"), fr = vals(g, "freezes");
    return {
      src, user, dir, kind, ...(rid ? { rid } : {}), samples: g.length, from: g[0].t, to: g[g.length - 1].t,
      lossAvg: avg(loss), lossP95: pct(loss, 95), lossMax: loss.length ? Math.max(...loss) : null,
      rttP50: pct(rtt, 50), rttP95: pct(rtt, 95), jitterAvg: avg(jit), jitterP95: pct(jit, 95),
      kbpsAvg: avg(vals(g, "kbps")), fpsMin: fps.length ? Math.min(...fps) : null, fpsAvg: avg(fps),
      freezes: fr.length ? Math.max(...fr) - Math.min(...fr) : null,
      badWindows: g.filter((r) => (r.lossPct ?? 0) > 5 || (r.rttMs ?? 0) > 450 || (r.kind === "video" && r.dir === "in" && r.fps !== null && r.fps < 15)).length,
    };
  });
}

export const callTelemetry = new CallTelemetryStore();
