/**
 * Persistent UDP recovery policy (pure, clock-injected so it is unit-testable).
 *
 * Direct UDP (mediasoup) is the preferred path. When it drops mid-call the engine moves to the existing LiveKit
 * TCP/TURN-443 path as a TEMPORARY bridge, then keeps trying to return to UDP until hang-up:
 *  - only after the TCP bridge has been stable for `tcpStableMs` (hysteresis: never leave a path that just settled),
 *  - with exponential backoff between attempts (`baseBackoffMs` doubling, capped at `maxBackoffMs`, ±jitter),
 *  - an attempt only counts as a success once UDP has held for `udpHoldMs`; a drop before that is a failed attempt
 *    and the backoff keeps growing (anti-flap).
 * The LiveKit fallback itself is not changed by this module.
 */
export interface UdpRecoveryOptions {
  tcpStableMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  udpHoldMs: number;
  /** failures only reset after UDP has held this long: a path that drops every ~1.5 min must keep backing off */
  resetAfterMs: number;
  /** 0..1 fraction of jitter applied to each backoff */
  jitter: number;
  random: () => number;
}

export const UDP_RECOVERY_DEFAULTS: UdpRecoveryOptions = {
  tcpStableMs: 20_000,
  baseBackoffMs: 15_000,
  maxBackoffMs: 120_000,
  udpHoldMs: 30_000,
  resetAfterMs: 300_000,
  jitter: 0.2,
  random: Math.random,
};

export type UdpPath = "udp" | "tcp" | "udp-trial" | "ended";

export class UdpRecoveryPolicy {
  readonly o: UdpRecoveryOptions;
  path: UdpPath = "udp";
  /** consecutive failed UDP trials (reset only after UDP holds for udpHoldMs) */
  failures = 0;
  private tcpStableSince: number | null = null;
  private nextTryAt = 0;
  private trialStartedAt = 0;
  private everDropped = false;

  constructor(opts: Partial<UdpRecoveryOptions> = {}) {
    this.o = { ...UDP_RECOVERY_DEFAULTS, ...opts };
  }

  backoffMs(failures = this.failures) {
    const raw = Math.min(this.o.maxBackoffMs, this.o.baseBackoffMs * 2 ** Math.max(0, failures));
    const j = raw * this.o.jitter * (this.o.random() * 2 - 1);
    return Math.max(this.o.baseBackoffMs * (1 - this.o.jitter), Math.round(raw + j));
  }

  /** UDP failed/degraded (initial drop or a failed trial): the engine bridges over TCP. */
  onUdpDrop(now: number) {
    if (this.path === "ended") return;
    if (this.path === "udp-trial" || (this.path === "udp" && this.everDropped && now - this.trialStartedAt < this.o.resetAfterMs)) this.failures++;
    this.everDropped = true;
    this.path = "tcp";
    this.tcpStableSince = null;
    this.nextTryAt = now + this.backoffMs();
  }

  /** TCP bridge connected / reconnected. */
  onTcpConnected(now: number) {
    if (this.path !== "tcp") return;
    this.tcpStableSince ??= now;
  }

  /** TCP bridge itself is reconnecting: restart the stability window. */
  onTcpUnstable() {
    this.tcpStableSince = null;
  }

  /** Should the engine ask the server to restore UDP now? */
  shouldTryUdp(now: number) {
    return this.path === "tcp" && this.tcpStableSince !== null && now - this.tcpStableSince >= this.o.tcpStableMs && now >= this.nextTryAt;
  }

  /** The engine started a UDP trial (server restore accepted). */
  onTrialStart(now: number) {
    if (this.path !== "tcp") return;
    this.path = "udp-trial";
    this.trialStartedAt = now;
  }

  /** The restore request was refused (e.g. server hysteresis) – stay on TCP and back off. */
  onTrialRefused(now: number, retryInMs?: number) {
    if (this.path === "ended") return;
    this.path = "tcp";
    this.nextTryAt = now + Math.max(retryInMs ?? 0, this.backoffMs());
  }

  /** UDP transport connected during a trial; call `tick` to promote after udpHoldMs. */
  tick(now: number) {
    if (this.path === "udp-trial" && now - this.trialStartedAt >= this.o.udpHoldMs) this.path = "udp";
    if (this.path === "udp" && this.everDropped && now - this.trialStartedAt >= this.o.resetAfterMs) this.failures = 0;
  }

  end() {
    this.path = "ended";
  }
}
