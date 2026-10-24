// Mid-call coturn relay login refresh (Donny, Oct 24 2026). Mediasoup call TURN logins live 10 min and coturn re-checks
// the username expiry on every allocation Refresh, so a relayed call used to drop at 10-15 min. Around 8 min into the
// call (and every 8 min after) fetch a fresh login, hand it to both transports (RTCPeerConnection.setConfiguration via
// mediasoup-client updateIceServers: no renegotiation, media keeps flowing), and only when the call is actually on the
// relay run an ICE restart so a new allocation is made with the fresh login before the old one expires
// (make-before-break: the current pair carries media until the new one is selected). Direct-UDP calls are untouched.
import type { TurnIceServer } from "../types";

export const TURN_REFRESH_FIRST_MS = 8 * 60_000;
export const TURN_REFRESH_EVERY_MS = 8 * 60_000;
export const TURN_REFRESH_RETRY_MS = 30_000;

type TransportLike = { updateIceServers?: (o: { iceServers: TurnIceServer[] }) => Promise<void>; getStats?: () => Promise<RTCStatsReport> };
export type RefreshableSession = { restartIceAll?: () => Promise<void>; lastIceRestartOk?: boolean | null };

export type TurnRefreshDeps = {
  /** fetch a fresh short-lived login for this call (server: call:turnRefresh) */
  fetch: (callId: string) => Promise<TurnIceServer[] | null>;
  /** the live mediasoup session of this call, or null (native app sessions own their own transports) */
  session: () => RefreshableSession | null;
  /** remember the fresh login for later rebuilds / relay fallback */
  remember: (iceServers: TurnIceServer[]) => void;
  log?: (ev: string, d?: Record<string, unknown>) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
};

function transportsOf(s: RefreshableSession): TransportLike[] {
  const r = s as unknown as { send?: TransportLike | null; recv?: TransportLike | null };
  return [r.send, r.recv].filter((t): t is TransportLike => !!t);
}

/** true when any transport's selected ICE pair uses a TURN relay candidate */
export async function onRelay(s: RefreshableSession): Promise<boolean> {
  for (const t of transportsOf(s)) {
    const stats = await t.getStats?.().catch(() => null);
    if (!stats) continue;
    const byId = new Map<string, Record<string, unknown>>();
    stats.forEach((v: unknown) => { const r = v as Record<string, unknown>; byId.set(String(r.id), r); });
    for (const r of byId.values()) {
      const pairId = r.type === "transport" ? r.selectedCandidatePairId : undefined;
      const isSel = r.type === "candidate-pair" && (r.selected === true || (r.nominated === true && r.state === "succeeded"));
      const selected = pairId ? byId.get(String(pairId)) : isSel ? r : undefined;
      if (!selected) continue;
      const local = byId.get(String(selected.localCandidateId));
      const remote = byId.get(String(selected.remoteCandidateId));
      if (local?.candidateType === "relay" || remote?.candidateType === "relay") return true;
    }
  }
  return false;
}

export class TurnRefresher {
  private timer: unknown = null;
  private callId: string | null = null;
  refreshes = 0;
  constructor(private deps: TurnRefreshDeps) {}

  private set(fn: () => void, ms: number) {
    this.timer = (this.deps.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms);
  }

  /** idempotent per call: a rebuild/fallback of the same call keeps the original schedule */
  start(callId: string) {
    if (this.callId === callId && this.timer) return;
    this.stop();
    this.callId = callId;
    this.set(() => void this.tick(callId), TURN_REFRESH_FIRST_MS);
  }

  stop() {
    if (this.timer) (this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
    this.callId = null;
  }

  async tick(callId: string): Promise<boolean> {
    if (this.callId !== callId) return false;
    this.timer = null;
    let ok = false;
    try {
      const ice = await this.deps.fetch(callId);
      if (this.callId !== callId) return false;
      if (ice?.length) {
        this.deps.remember(ice);
        const s = this.deps.session();
        if (s) {
          await Promise.all(transportsOf(s).map((t) => t.updateIceServers?.({ iceServers: ice })));
          const relay = await onRelay(s);
          if (relay) await s.restartIceAll?.();
          this.deps.log?.("turn-refresh", { relay, restartOk: relay ? s.lastIceRestartOk ?? null : null });
        } else this.deps.log?.("turn-refresh", { session: false });
        ok = true;
        this.refreshes++;
      }
    } catch (e) {
      this.deps.log?.("turn-refresh-failed", { error: String((e as Error)?.message ?? e).slice(0, 120) });
    }
    if (this.callId === callId) this.set(() => void this.tick(callId), ok ? TURN_REFRESH_EVERY_MS : TURN_REFRESH_RETRY_MS);
    return ok;
  }
}
