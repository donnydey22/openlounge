// Network-only recovery: ICE "disconnected" gets a grace period (browsers often self-heal), then an ICE restart with
// fresh OL ICE credentials; bounded backoff. Relay (OL TURN) is just another ICE candidate the restart may select.
// Invoked ONLY from transport state — never from mute, silence, zero bitrate, or device/permission errors.
// First connect: once the call is answered, if connectionState hasn't reached "connected" within FIRST_CONNECT_MS the
// same backoff ladder starts, and those restarts gather relay candidates only (OL TURN, incl. TURNS on 443). Never wait
// for "failed": it can take 30 s+ (Philipp Hancke: restart 3-4 s after disconnected; industry practice 2-3 s).

export interface RecoveryHooks {
  /** relayOnly: set when the call has never connected; the restart gathers relay candidates only. */
  restart(attempt: number, relayOnly: boolean): Promise<void>;
  giveUp(): void;
  log?(ev: string, data?: Record<string, unknown>): void;
}

export const DISCONNECT_GRACE_MS = 2_500;
export const RESTART_BACKOFF_MS = [0, 1_000, 2_000, 4_000, 8_000];
export const RECOVERY_MAX_MS = 45_000;
export const FIRST_CONNECT_MS = 2_500;

export class NetworkRecovery {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private since = 0;
  private stopped = false;
  private firstTimer: ReturnType<typeof setTimeout> | null = null;
  private everConnected = false;
  constructor(private h: RecoveryHooks, private now: () => number = Date.now) {}

  onTransportState(state: RTCIceConnectionState) {
    if (this.stopped) return;
    // Before the first full connect, only connectionState "connected" (onConnected) clears the ladder.
    if (state === "connected" || state === "completed") return this.everConnected ? this.healthy() : undefined;
    if (state === "disconnected") return this.schedule(DISCONNECT_GRACE_MS);
    if (state === "failed") return this.schedule(0);
  }

  /** The call was answered (callee applied the offer / caller applied the answer): start the first-connect clock. */
  armFirstConnect() {
    if (this.stopped || this.everConnected || this.firstTimer) return;
    this.firstTimer = setTimeout(() => {
      this.firstTimer = null;
      if (this.stopped || this.everConnected) return;
      this.h.log?.("first-connect-timeout", { ms: FIRST_CONNECT_MS });
      this.schedule(0);
    }, FIRST_CONNECT_MS);
  }

  /** RTCPeerConnection.connectionState reached "connected" (ICE + DTLS). */
  onConnected() {
    this.everConnected = true;
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.firstTimer = null;
    this.healthy();
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
      const relayOnly = !this.everConnected;
      this.h.log?.("ice-restart", { attempt: n, relayOnly });
      this.h.restart(n, relayOnly).catch(() => this.schedule(0));
    }, wait);
  }

  private healthy() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.attempt = 0;
    this.since = 0;
  }

  get recovering() { return this.since !== 0; }
  get neverConnected() { return !this.everConnected; }

  stop() {
    this.stopped = true;
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.firstTimer = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
