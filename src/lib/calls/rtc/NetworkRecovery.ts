// Network-only recovery: ICE "disconnected" gets a grace period (browsers often self-heal), then an ICE restart with
// fresh OL ICE credentials; bounded backoff. Relay (OL TURN) is just another ICE candidate the restart may select.
// Invoked ONLY from transport state — never from mute, silence, zero bitrate, or device/permission errors.

export interface RecoveryHooks {
  restart(attempt: number): Promise<void>;
  giveUp(): void;
  log?(ev: string, data?: Record<string, unknown>): void;
}

export const DISCONNECT_GRACE_MS = 2_500;
export const RESTART_BACKOFF_MS = [0, 1_000, 2_000, 4_000, 8_000];
export const RECOVERY_MAX_MS = 45_000;

export class NetworkRecovery {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private since = 0;
  private stopped = false;
  constructor(private h: RecoveryHooks, private now: () => number = Date.now) {}

  onTransportState(state: RTCIceConnectionState) {
    if (this.stopped) return;
    if (state === "connected" || state === "completed") return this.healthy();
    if (state === "disconnected") return this.schedule(DISCONNECT_GRACE_MS);
    if (state === "failed") return this.schedule(0);
  }

  /** browser went online / network type changed: restart promptly (Signal restarts ICE on network change) */
  onNetworkChange() {
    if (!this.stopped) this.schedule(0);
  }

  private schedule(delay: number) {
    if (this.timer) return;
    if (!this.since) this.since = this.now();
    if (this.now() - this.since > RECOVERY_MAX_MS) { this.stop(); this.h.giveUp(); return; }
    const wait = Math.max(delay, RESTART_BACKOFF_MS[Math.min(this.attempt, RESTART_BACKOFF_MS.length - 1)]);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      const n = ++this.attempt;
      this.h.log?.("ice-restart", { attempt: n });
      this.h.restart(n).catch(() => this.schedule(0));
    }, wait);
  }

  private healthy() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.since = 0;
  }

  get recovering() { return this.since !== 0; }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
