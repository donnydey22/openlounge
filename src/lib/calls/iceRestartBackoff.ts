/**
 * Fast same-server ICE restart on EVERY drop (Donny, Oct 24 2026 5:41 AM MST), with backoff so it can't loop.
 * A drop restarts ICE in place right away unless one was started less than `gapMs` ago. Each restart that does not
 * reach "connected" doubles the gap (base 1 s, cap 30 s). Reaching "connected" resets it to the base.
 */
export const ICE_RESTART_BASE_MS = 1_000;
export const ICE_RESTART_MAX_MS = 30_000;

export class IceRestartBackoff {
  private last = -Infinity;
  private gap = ICE_RESTART_BASE_MS;
  private pending = false;
  constructor(private readonly base = ICE_RESTART_BASE_MS, private readonly max = ICE_RESTART_MAX_MS) { this.gap = base; }
  /** true → restart ICE now */
  shouldRestart(now: number): boolean {
    if (now - this.last < this.gap) return false;
    if (this.pending) this.gap = Math.min(this.gap * 2, this.max);
    this.last = now;
    this.pending = true;
    return true;
  }
  onConnected() {
    this.pending = false;
    this.gap = this.base;
  }
  get currentGapMs() { return this.gap; }
}
