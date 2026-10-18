// Android app, WebView media path only (spec /workspace/specs/android-webaudio-suspension-spec.md, Phase A W1/W2/W5/W6):
// keep a call's audio alive across Android background suspension / freeze. iOS, desktop and the native-media path
// never construct this. Conservative by design: every step is in place (no renegotiation), and anything beyond an
// ICE restart is handed to the engine's EXISTING recovery (transport rebuild -> LiveKit last resort -> clear end).

export type LifecycleIce = "connected" | "checking" | "disconnected" | "failed" | "unknown";
export type LifecycleHealth = { ice: LifecycleIce; inboundPackets: number | null };

export type LifecycleDeps = {
  /** remote voice elements of the call */
  audioEls(): HTMLMediaElement[];
  /** AudioContexts the call uses (shared page context) */
  audioContexts(): Array<Pick<AudioContext, "state" | "resume">>;
  /** local mic track (null on native / LiveKit paths) */
  micTrack(): MediaStreamTrack | null;
  /** existing in-place mic re-acquire (getUserMedia + producer.replaceTrack, no renegotiation) */
  recoverMic(): Promise<void>;
  /** transport stats summary; null when unavailable */
  health(): Promise<LifecycleHealth | null>;
  /** existing in-place ICE restart on both transports */
  restartIce(): Promise<void>;
  /** existing full recovery (transport rebuild -> LiveKit last resort -> only then end) */
  escalate(reason: string): void;
  /** engine already recovering: the ladder stays out of its way */
  busyRecovering(): boolean;
  visible(): boolean;
  log(ev: string, extra: Record<string, string | number | boolean>): void;
  now?(): number;
};

export type Verdict = { kind: "ok" | "paused" | "killed"; why: string };

export const LIFECYCLE = {
  HEARTBEAT_MS: 1_000,
  GAP_MS: 3_000, // a tick gap above this = page frozen/throttled
  KILL_GAP_MS: 10_000,
  STATS_MS: 2_000,
  STALL_MS: 4_000, // no inbound packets this long with ICE connected = dead media
  ICE_WAIT_MS: 5_000,
  DEBOUNCE_MS: 250,
  STALL_COOLDOWN_MS: 30_000,
};

/** Killed vs paused (spec §2), from what the page can see right now. */
export function classify(s: {
  ctxStates: string[];
  ctxResumeFailed: boolean;
  micState: "live" | "muted" | "ended" | "none";
  remoteEnded: boolean;
  ice: LifecycleIce;
  gapMs: number;
}): Verdict {
  if (s.ctxStates.includes("closed") || s.ctxResumeFailed) return { kind: "killed", why: "audio-context" };
  if (s.micState === "ended") return { kind: "killed", why: "mic-ended" };
  if (s.remoteEnded) return { kind: "killed", why: "remote-ended" };
  if (s.ice === "failed") return { kind: "killed", why: "ice-failed" };
  if (s.gapMs > LIFECYCLE.KILL_GAP_MS && s.ice === "disconnected") return { kind: "killed", why: "long-freeze" };
  if (s.ctxStates.some((x) => x !== "running") || s.micState === "muted" || s.ice === "disconnected" || s.gapMs > LIFECYCLE.GAP_MS)
    return { kind: "paused", why: s.ice === "disconnected" ? "ice-disconnected" : s.micState === "muted" ? "mic-muted" : s.gapMs > LIFECYCLE.GAP_MS ? "frozen" : "audio-context" };
  return { kind: "ok", why: "" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AndroidCallLifecycle {
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastTick = 0;
  private maxGapMs = 0;
  private hiddenAt: number | null = null;
  private lastBgMs = 0;
  private running = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private lastPackets: number | null = null;
  private lastGrowth = 0;
  private lastStallRun = -Infinity;
  private stopped = false;
  private readonly now: () => number;

  constructor(private d: LifecycleDeps) {
    this.now = d.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  }

  start() {
    this.lastTick = this.now();
    this.lastGrowth = this.now();
    this.timers.push(setInterval(() => this.tick(), LIFECYCLE.HEARTBEAT_MS));
    this.timers.push(setInterval(() => void this.pollStats(), LIFECYCLE.STATS_MS));
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onEvent);
      document.addEventListener("freeze", this.onFreeze);
      document.addEventListener("resume", this.onEvent);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("pageshow", this.onEvent);
      window.addEventListener("focus", this.onEvent);
      window.addEventListener("openlounge:native-visibility", this.onEvent);
    }
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.debounce) clearTimeout(this.debounce);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onEvent);
      document.removeEventListener("freeze", this.onFreeze);
      document.removeEventListener("resume", this.onEvent);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("pageshow", this.onEvent);
      window.removeEventListener("focus", this.onEvent);
      window.removeEventListener("openlounge:native-visibility", this.onEvent);
    }
  }

  /** diag summary for call end / telemetry */
  summary() {
    return { maxGapMs: Math.round(this.maxGapMs), bgMs: Math.round(this.lastBgMs) };
  }

  private onFreeze = () => {
    if (this.hiddenAt == null) this.hiddenAt = this.now();
  };

  private onEvent = (e?: Event) => {
    if (this.stopped) return;
    if (!this.d.visible()) {
      if (this.hiddenAt == null) this.hiddenAt = this.now();
      return;
    }
    if (this.debounce) clearTimeout(this.debounce);
    const ev = e?.type ?? "foreground";
    this.debounce = setTimeout(() => void this.run(ev, 0), LIFECYCLE.DEBOUNCE_MS);
  };

  /** W5 heartbeat: a big tick gap means the page was frozen/throttled. */
  tick() {
    const t = this.now();
    const gap = t - this.lastTick;
    this.lastTick = t;
    if (gap > this.maxGapMs) this.maxGapMs = gap;
    if (gap > LIFECYCLE.GAP_MS && this.d.visible()) void this.run("gap", gap);
  }

  /** W5 stalled media: ICE connected but inbound audio packets stop growing for STALL_MS while visible. */
  async pollStats() {
    if (this.stopped || !this.d.visible() || this.running || this.d.busyRecovering()) return;
    const h = await this.d.health().catch(() => null);
    if (!h || h.inboundPackets == null) return;
    const t = this.now();
    if (this.lastPackets == null || h.inboundPackets > this.lastPackets) {
      this.lastPackets = h.inboundPackets;
      this.lastGrowth = t;
      return;
    }
    if (h.ice === "connected" && t - this.lastGrowth >= LIFECYCLE.STALL_MS && t - this.lastStallRun >= LIFECYCLE.STALL_COOLDOWN_MS) {
      this.lastStallRun = t;
      void this.run("stall", 0, true);
    }
  }

  /** W1 unified foreground handler + spec §2 stepwise recovery ladder. */
  async run(ev: string, gapMs: number, stall = false) {
    if (this.running || this.stopped) return;
    this.running = true;
    const t0 = this.now();
    const bgMs = this.hiddenAt != null ? t0 - this.hiddenAt : 0;
    if (this.hiddenAt != null) this.lastBgMs = bgMs;
    this.hiddenAt = null;
    const path: string[] = [];
    try {
      // 1. resume audio contexts + replay paused remote voice (<= 0.5 s)
      const ctxs = this.d.audioContexts();
      let ctxResumeFailed = false;
      await Promise.all(ctxs.map(async (c) => {
        if (c.state === "running" || c.state === "closed") return;
        const ok = await Promise.race([c.resume().then(() => true, () => false), sleep(2_000).then(() => false)]);
        if (!ok) ctxResumeFailed = true;
      }));
      let remoteEnded = false;
      for (const el of this.d.audioEls()) {
        const tracks = (el.srcObject as MediaStream | null)?.getAudioTracks?.() ?? [];
        if (tracks.some((x) => x.readyState === "ended")) remoteEnded = true;
        if (el.paused) void el.play().catch(() => {});
      }
      path.push("resume");
      const mic = this.d.micTrack();
      const micState = !mic ? "none" : mic.readyState === "ended" ? "ended" : mic.muted ? "muted" : "live";
      const h = await this.d.health().catch(() => null);
      const ice = h?.ice ?? "unknown";
      const verdict = classify({ ctxStates: ctxs.map((c) => c.state), ctxResumeFailed, micState, remoteEnded, ice, gapMs });
      if (verdict.kind === "ok" && !stall) {
        if (ev === "gap" || bgMs > 0) this.d.log("lifecycle", { trig: ev, verdict: "ok", bgMs: Math.round(bgMs), maxGapMs: Math.round(this.maxGapMs), recoveryMs: 0, path: "resume" });
        return;
      }
      if (this.d.busyRecovering()) {
        path.push("engine");
        return this.report(ev, verdict, bgMs, t0, path);
      }
      // 2. fresh mic via replaceTrack (<= 2 s) — only while visible (Android 10 blocks background mic)
      if ((micState === "ended" || micState === "muted") && this.d.visible()) {
        path.push("mic");
        await Promise.race([this.d.recoverMic().catch(() => {}), sleep(2_000)]);
      }
      // 3. existing ICE restart (<= 5 s) when ICE is down, or media stalled
      if (ice === "disconnected" || ice === "failed" || stall || remoteEnded) {
        path.push("ice");
        await Promise.race([this.d.restartIce().catch(() => {}), sleep(LIFECYCLE.ICE_WAIT_MS)]);
        let after = await this.d.health().catch(() => null);
        for (let i = Math.ceil(LIFECYCLE.ICE_WAIT_MS / 500); !this.stopped && after?.ice !== "connected" && i > 0; i--) {
          await sleep(500);
          after = await this.d.health().catch(() => null);
        }
        // 4-6. still down: hand over to the existing recovery (rebuild -> LiveKit last resort -> only then end).
        // A stall with ICE connected never escalates on its own (peer could simply be muted).
        if (!this.stopped && after && after.ice !== "connected" && !this.d.busyRecovering()) {
          path.push("escalate");
          this.d.escalate(`lifecycle-${verdict.why || ev}`);
        }
      }
      this.report(ev, verdict, bgMs, t0, path);
    } finally {
      this.running = false;
      this.lastTick = this.now();
    }
  }

  private report(ev: string, v: Verdict, bgMs: number, t0: number, path: string[]) {
    this.d.log("lifecycle", {
      trig: ev,
      verdict: v.kind === "ok" ? "stall" : `${v.kind}:${v.why}`,
      bgMs: Math.round(bgMs),
      maxGapMs: Math.round(this.maxGapMs),
      recoveryMs: Math.round(this.now() - t0),
      path: path.join(">"),
    });
  }
}

/** Summarize mediasoup transport stats for the lifecycle: ICE state + inbound audio packets. */
export function summarizeStats(reports: RTCStatsReport[]): LifecycleHealth | null {
  if (!reports.length) return null;
  let ice: LifecycleIce = "unknown";
  let packets: number | null = null;
  const rank: Record<LifecycleIce, number> = { failed: 4, disconnected: 3, checking: 2, connected: 1, unknown: 0 };
  for (const r of reports) {
    r.forEach((s: Record<string, unknown>) => {
      if (s.type === "transport") {
        const st = String(s.iceState ?? (s.dtlsState === "connected" ? "connected" : s.dtlsState === "failed" ? "failed" : ""));
        const v: LifecycleIce = st === "connected" || st === "completed" ? "connected" : st === "disconnected" ? "disconnected" : st === "failed" || st === "closed" ? "failed" : st === "checking" || st === "new" ? "checking" : "unknown";
        if (rank[v] > rank[ice]) ice = v;
      } else if (s.type === "inbound-rtp" && (s.kind === "audio" || s.mediaType === "audio") && typeof s.packetsReceived === "number") {
        packets = (packets ?? 0) + s.packetsReceived;
      }
    });
  }
  return { ice, inboundPackets: packets };
}
