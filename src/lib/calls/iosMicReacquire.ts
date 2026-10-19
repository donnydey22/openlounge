// iOS outgoing-video mic re-acquire (Donny, 9:38–9:39 PM MST Oct 18).
// Calls d9abe8df / a84f91db / 61bcc5f2: on video calls the iPhone app PLACES to an Android phone, CallKit didActivate
// plus the native ringback interrupt WKWebView's capture session — the mic track stays "live" but sends level 0 and
// 0 kbps from the ring onward. Incoming video (17b93f6a) is fine. WebKit bug 208516 workaround: getUserMedia({audio})
// again and replaceTrack onto the existing mediasoup audio producer (camera untouched, no renegotiation).
// Gated tightly and behind the server switch CALL_IOS_MIC_REACQUIRE (grant field iosMicReacquire; absent = off).

export type CallPlatform = "ios" | "android" | "web";

export interface IosMicGateInput {
  /** server switch carried on the media grant (CALL_IOS_MIC_REACQUIRE=on) */
  flag: boolean;
  /** local wrapper platform (nativePlatform() ?? "web") */
  localPlatform: CallPlatform | null;
  role: "caller" | "callee" | null;
  video: boolean;
  /** app-owned native call media is active (never touch that path) */
  nativeMedia: boolean;
  /** callee's platform as reported to the server on accept; unknown = never fire */
  peerPlatform: CallPlatform | null | undefined;
  provider: "mediasoup" | "livekit" | null | undefined;
}

/** Fires ONLY for: iOS wrapper + local user is the caller + video + WebView media + Android callee + mediasoup + flag on. */
export function iosMicReacquireEligible(g: IosMicGateInput): boolean {
  return (
    g.flag === true &&
    g.localPlatform === "ios" &&
    g.role === "caller" &&
    g.video === true &&
    g.nativeMedia === false &&
    g.peerPlatform === "android" &&
    g.provider === "mediasoup"
  );
}

export interface MicSample {
  /** media-source audioLevel (0..1) or null when not reported */
  level: number | null;
  /** outbound audio kbps since the previous sample, or null on the first sample */
  outKbps: number | null;
}

export const MIC_SILENT_LEVEL = 0.001;
export const MIC_SILENT_KBPS = 1;
/** consecutive silent 1 s samples before acting (~2 s) */
export const MIC_SILENT_SAMPLES = 2;
export const MIC_REACQUIRE_MAX_TRIES = 3;
export const MIC_REACQUIRE_BACKOFF_MS = [0, 2_000, 4_000];

/** Silent = the sender is dead: no level AND (practically) no bytes. A quiet user still sends Opus at several kbps. */
export function micSampleSilent(s: MicSample): boolean {
  if (s.outKbps === null) return false;
  const lvl = s.level ?? 0;
  return lvl < MIC_SILENT_LEVEL && s.outKbps < MIC_SILENT_KBPS;
}

/** Pull the local audio media-source level + cumulative outbound audio bytes out of transport stats. */
export function readMicStats(reports: RTCStatsReport[]): { level: number | null; bytes: number } {
  let level: number | null = null, bytes = 0;
  for (const rep of reports)
    rep.forEach((st: Record<string, unknown>) => {
      if (st.kind !== "audio") return;
      if (st.type === "media-source" && typeof st.audioLevel === "number") level = st.audioLevel;
      else if (st.type === "outbound-rtp") bytes += Number(st.bytesSent ?? 0);
    });
  return { level, bytes };
}

export interface IosMicWatchDeps {
  stats(): Promise<RTCStatsReport[]>;
  /** re-acquire with the same constraints + replaceTrack; resolves true when a new track went in */
  reacquire(): Promise<boolean>;
  /** user-muted (producer paused): never treat as silence */
  muted(): boolean;
  alive(): boolean;
  log(ev: "ios-mic-reacquire-start" | "ios-mic-reacquire-ok" | "ios-mic-reacquire-fail", extra: Record<string, string | number | boolean>): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
  now?(): number;
}

/**
 * Samples once a second; after MIC_SILENT_SAMPLES silent samples it re-acquires (at most MIC_REACQUIRE_MAX_TRIES,
 * with backoff). Never hangs up, never touches video. Stops when the mic is sending or tries are spent.
 */
export class IosMicWatch {
  private timer: unknown = null;
  private silent = 0;
  private tries = 0;
  private last: { bytes: number; t: number } | null = null;
  private busy = false;
  private stopped = false;
  constructor(private d: IosMicWatchDeps) {}
  private set(fn: () => void, ms: number) {
    this.timer = (this.d.setTimer ?? ((f: () => void, m: number) => setTimeout(f, m)))(fn, ms);
  }
  private now() {
    return (this.d.now ?? Date.now)();
  }
  start(delayMs = 1_000) {
    if (this.stopped) return;
    if (this.timer) (this.d.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.silent = 0;
    this.last = null;
    this.set(() => void this.tick(), delayMs);
  }
  /** native-audio-resume / session-activated: look again (tries budget is kept) */
  rearm() {
    if (!this.stopped && !this.busy && this.tries < MIC_REACQUIRE_MAX_TRIES) this.start(1_000);
  }
  stop() {
    this.stopped = true;
    if (this.timer) (this.d.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }
  /** idle: no timer pending, not stopped (rearm() can restart) */
  get idle() {
    return !this.stopped && !this.timer && !this.busy;
  }
  get attempts() {
    return this.tries;
  }
  private async sample(): Promise<MicSample> {
    const { level, bytes } = readMicStats(await this.d.stats().catch(() => []));
    const t = this.now();
    const prev = this.last;
    this.last = { bytes, t };
    const dt = prev ? (t - prev.t) / 1000 : 0;
    return { level, outKbps: prev && dt > 0 ? ((bytes - prev.bytes) * 8) / dt / 1000 : null };
  }
  async tick(): Promise<void> {
    this.timer = null;
    if (this.stopped || !this.d.alive()) return this.stop();
    const s = await this.sample();
    if (this.stopped) return;
    if (this.d.muted() || !micSampleSilent(s)) {
      this.silent = 0;
      // sending fine: go idle (a later native-audio-resume rearms the check)
      if (s.outKbps !== null && !this.d.muted()) return;
      return this.set(() => void this.tick(), 1_000);
    }
    if (++this.silent < MIC_SILENT_SAMPLES) return this.set(() => void this.tick(), 1_000);
    if (this.tries >= MIC_REACQUIRE_MAX_TRIES) return this.stop();
    this.busy = true;
    const attempt = ++this.tries;
    const before = s.level ?? 0;
    this.d.log("ios-mic-reacquire-start", { attempt, beforeLevel: round3(before), beforeKbps: round1(s.outKbps ?? 0) });
    const ok = await this.d.reacquire().catch(() => false);
    this.busy = false;
    if (this.stopped) return;
    if (!ok) {
      this.d.log("ios-mic-reacquire-fail", { attempt, stage: "replace", beforeLevel: round3(before) });
    } else {
      // measure the new track over ~2 s before declaring success
      this.last = null;
      await this.sample();
      await new Promise<void>((r) => this.set(r, 2_000));
      if (this.stopped) return;
      const after = await this.sample();
      if (!micSampleSilent(after) || this.d.muted()) {
        this.d.log("ios-mic-reacquire-ok", { attempt, beforeLevel: round3(before), afterLevel: round3(after.level ?? 0), afterKbps: round1(after.outKbps ?? 0) });
        return; // idle; rearm() may check again on the next session activation
      }
      this.d.log("ios-mic-reacquire-fail", { attempt, stage: "still-silent", beforeLevel: round3(before), afterLevel: round3(after.level ?? 0), afterKbps: round1(after.outKbps ?? 0) });
    }
    if (this.tries >= MIC_REACQUIRE_MAX_TRIES) return this.stop();
    this.silent = 0;
    this.last = null;
    this.set(() => void this.tick(), MIC_REACQUIRE_BACKOFF_MS[this.tries] ?? 4_000);
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const round1 = (x: number) => Math.round(x * 10) / 10;
