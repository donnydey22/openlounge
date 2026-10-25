// FX-081 per-stream call telemetry (Donny, Oct 24 2026 8:51 PM MST: "telemetry on every stream — packet loss, RTT,
// jitter — so degradation is visible before users complain"). Every TELEMETRY.sampleMs the client reduces the same
// transport stats the netAdapt ladder already reads (browser/Android page and the iPhone native lane via op:"stats")
// into one row per RTP stream and sends it to the server ("call:telemetry"). Read-only: never touches a sender.
export const TELEMETRY = { sampleMs: 5_000, maxStreams: 8, freezeGapMs: 1_500 } as const;

export type StreamSample = {
  dir: "in" | "out"; kind: "audio" | "video"; rid?: string;
  lossPct: number | null; rttMs: number | null; jitterMs: number | null; kbps: number | null; fps: number | null;
  freezes: number | null; freezeMs: number | null; w?: number; h?: number; layer?: string;
};

type Prev = Map<string, { at: number; bytes: number; lost: number; pkts: number }>;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const r1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

/** Reduce RTCStatsReports (or native plain-object lists) to per-stream rows. `prev` carries counters between samples. */
export function summarizeStreams(reports: Iterable<RTCStatsReport | Array<Record<string, unknown>>>, prev: Prev, now = Date.now()): StreamSample[] {
  const all: Record<string, any>[] = [];
  for (const rep of reports) (rep as any).forEach((r: any) => all.push(r));
  const byId = new Map(all.map((r) => [r.id, r]));
  let pairRtt: number | null = null;
  for (const r of all) if (r.type === "candidate-pair" && (r.nominated || r.selected || r.state === "succeeded") && num(r.currentRoundTripTime) !== null) pairRtt = Math.max(pairRtt ?? 0, r.currentRoundTripTime * 1000);
  const out: StreamSample[] = [];
  for (const r of all) {
    if ((r.type !== "inbound-rtp" && r.type !== "outbound-rtp") || (r.kind !== "audio" && r.kind !== "video")) continue;
    const dir = r.type === "inbound-rtp" ? "in" : "out";
    const key = `${dir}:${r.kind}:${r.ssrc ?? r.id}`;
    const bytes = num(dir === "in" ? r.bytesReceived : r.bytesSent) ?? 0;
    const remote = dir === "out" ? byId.get(r.remoteId) ?? all.find((x) => x.type === "remote-inbound-rtp" && x.ssrc === r.ssrc) : null;
    const lost = dir === "in" ? num(r.packetsLost) ?? 0 : num(remote?.packetsLost) ?? 0;
    const pkts = dir === "in" ? num(r.packetsReceived) ?? 0 : num(r.packetsSent) ?? 0;
    const p = prev.get(key);
    prev.set(key, { at: now, bytes, lost, pkts });
    const dt = p ? (now - p.at) / 1000 : 0;
    const dLost = p ? Math.max(0, lost - p.lost) : 0, dPkts = p ? Math.max(0, pkts - p.pkts) : 0;
    const lossPct = p ? (dLost + dPkts > 0 ? (100 * dLost) / (dLost + dPkts) : 0) : (dir === "out" && num(remote?.fractionLost) !== null ? remote!.fractionLost * 100 : null);
    const rtt = dir === "out" && num(remote?.roundTripTime) !== null ? remote!.roundTripTime * 1000 : pairRtt;
    const jitterS = dir === "in" ? num(r.jitter) : num(remote?.jitter);
    out.push({
      dir, kind: r.kind, ...(r.rid ? { rid: String(r.rid) } : {}),
      lossPct: r1(lossPct), rttMs: r1(rtt), jitterMs: r1(jitterS === null ? null : jitterS * 1000),
      kbps: p && dt > 0 ? r1(((bytes - p.bytes) * 8) / dt / 1000) : null,
      fps: r.kind === "video" ? num(r.framesPerSecond) : null,
      freezes: dir === "in" && r.kind === "video" ? num(r.freezeCount) : null,
      freezeMs: dir === "in" && r.kind === "video" && num(r.totalFreezesDuration) !== null ? Math.round(r.totalFreezesDuration * 1000) : null,
      ...(num(r.frameWidth) ? { w: r.frameWidth, h: r.frameHeight } : {}),
    });
  }
  return out.slice(0, TELEMETRY.maxStreams);
}

/** One sampler per call; `send` is fire-and-forget (socket emit). */
export class CallTelemetry {
  private prev: Prev = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  constructor(private d: { callId: string; platform: string; stats: () => Promise<Iterable<RTCStatsReport | Array<Record<string, unknown>>>>; send: (payload: Record<string, unknown>) => void; net?: () => string | undefined }) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sample(), TELEMETRY.sampleMs);
  }
  async sample() {
    try {
      const streams = summarizeStreams(await this.d.stats(), this.prev);
      if (!streams.length) return;
      this.d.send({ callId: this.d.callId, seq: ++this.seq, t: Date.now(), platform: this.d.platform, net: this.d.net?.() ?? "", streams });
    } catch { /* telemetry never affects the call */ }
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
