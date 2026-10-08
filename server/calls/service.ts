// 1:1 audio/video calls (Telegram-style). Signaling over the existing WebSocket, media over LiveKit (one private
// LiveKit room per call, "openlounge-call-<id>"). Both participants' tokens are minted at RING time, so accepting is
// just "connect" (no extra round trip on the critical accept → first-audio path).
//
// Lifecycle: calling (caller sent call:start) → ringing (a callee device acked) → active (accepted) → ended.
// Outcomes: completed | missed (45s timeout) | declined | cancelled (caller hung up first) | busy | failed.
// Every ended call leaves one service message in the DM (store.appendCallMessage).
import { randomUUID } from "node:crypto";
import type { CallInfo, CallMedia, CallMeta, CallOutcome, CallPeer, CallPhase } from "../../src/lib/types";

const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
export const CALL_RING_TIMEOUT_MS = num("CALL_RING_TIMEOUT_MS", 45_000);
/** a call whose participants both lost every WebSocket for this long is over (LiveKit webhook usually ends it sooner) */
export const CALL_ORPHAN_MS = num("CALL_ORPHAN_MS", 60_000);
/** caller lost their socket while it was still ringing → cancel after this */
export const CALL_CALLER_GONE_MS = num("CALL_CALLER_GONE_MS", 15_000);
/**
 * Mid-call reconnect grace: an ACTIVE call survives either participant losing every WebSocket for this long
 * (tunnel, elevator, Wi-Fi → cellular). 45 s because LiveKit's own client retry schedule (resume with ICE restart, then
 * full rejoin) runs ≈ 44–52 s and its server keeps a dropped participant ≈ 20 s for a resume; most real drops are
 * < 30 s; and past ~45 s the other person is better served by "Call ended · connection lost" + one-tap call back
 * than by more silence. The heartbeat notices a dead socket within ~10–20 s, so the wall-clock budget is ~55–65 s.
 */
export const CALL_RECONNECT_GRACE_MS = num("CALL_RECONNECT_GRACE_MS", 45_000);
export const CALL_MAX_PER_10MIN = num("CALL_MAX_PER_10MIN", 12);
const ENDED_KEEP_MS = 10 * 60_000; // ended calls answer call:get ("Call ended") for a while
const METRIC_KEEP = 500;

export interface CallDeps {
  emitUser(userId: string, ev: string, data: unknown): void;
  /** does the user have any open (authenticated) socket? */
  isConnected(userId: string): boolean;
  /** does the user have a visible app/tab? (otherwise we push) */
  isForeground(userId: string): boolean;
  peer(userId: string): CallPeer | null;
  policy(callerId: string, calleeId: string): { ok: true } | { ok: false; reason: string; error: string };
  /** in a live audio room right now */
  inRoom(userId: string): boolean;
  appendCallMessage(meta: CallMeta, calleeId: string): void;
  /** LiveKit: null when audio isn't configured */
  mintToken(callId: string, userId: string, name: string): Promise<string | null>;
  mediaUrl(): string | null;
  closeMedia(callId: string): void;
  push?: {
    incoming(calleeId: string, call: CallInfo): void;
    cancel(calleeId: string, callId: string, reason: string): void;
  };
  now?(): number;
  log?(msg: string, extra?: Record<string, unknown>): void;
}

interface CallRec {
  id: string;
  callerId: string;
  calleeId: string;
  video: boolean;
  /** video was used at any point (upgrade) → "Video call" in history */
  everVideo: boolean;
  phase: CallPhase;
  createdAt: number;
  ackAt: number | null;
  answeredAt: number | null;
  endedAt: number | null;
  outcome: CallOutcome | null;
  tokens: Map<string, Promise<string | null>>;
  timer: NodeJS.Timeout | null;
  pushed: boolean;
  orphanSince: number | null;
  /** active call: when each participant lost their last socket (reconnect grace) */
  goneSince: Map<string, number>;
}

export type StartResult =
  | { ok: true; call: CallInfo; media: CallMedia | null }
  | { ok: false; error: string; reason: string; call?: CallInfo };

export class CallService {
  private calls = new Map<string, CallRec>();
  /** userId → live (calling/ringing/active) call id */
  private live = new Map<string, string>();
  private rate = new Map<string, number[]>();
  private metrics: { acceptToAudioMs: number[]; ringMs: number[] } = { acceptToAudioMs: [], ringMs: [] };
  private sweeper: NodeJS.Timeout;

  constructor(private d: CallDeps) {
    this.sweeper = setInterval(() => this.sweep(), num("CALL_SWEEP_MS", 5_000));
    this.sweeper.unref();
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  dispose() {
    clearInterval(this.sweeper);
    for (const c of this.calls.values()) if (c.timer) clearTimeout(c.timer);
  }

  /** Busy = already in a call (any phase) or in a live audio room. */
  isBusy(userId: string) {
    return this.live.has(userId) || this.d.inRoom(userId);
  }

  liveCallOf(userId: string): CallInfo | null {
    const id = this.live.get(userId);
    const c = id ? this.calls.get(id) : undefined;
    return c ? this.info(c) : null;
  }

  info(c: CallRec): CallInfo {
    const anon = (id: string): CallPeer => ({ id, name: "Open Lounge user", color: "#64748B", photoUrl: null });
    return {
      id: c.id,
      callerId: c.callerId,
      calleeId: c.calleeId,
      video: c.video,
      phase: c.phase,
      createdAt: c.createdAt,
      answeredAt: c.answeredAt,
      endedAt: c.endedAt,
      outcome: c.outcome,
      expiresAt: c.createdAt + CALL_RING_TIMEOUT_MS,
      caller: this.d.peer(c.callerId) ?? anon(c.callerId),
      callee: this.d.peer(c.calleeId) ?? anon(c.calleeId),
      ...(c.goneSince?.size ? { offline: [...c.goneSince.keys()] } : {}),
    };
  }

  private async media(c: CallRec, userId: string): Promise<CallMedia | null> {
    const url = this.d.mediaUrl();
    const t = c.tokens.get(userId);
    if (!url || !t) return null;
    const token = await t.catch(() => null);
    return token ? { url, token } : null;
  }

  private limited(userId: string) {
    const now = this.now();
    const arr = (this.rate.get(userId) ?? []).filter((t) => now - t < 10 * 60_000);
    if (arr.length >= CALL_MAX_PER_10MIN) {
      this.rate.set(userId, arr);
      return true;
    }
    arr.push(now);
    this.rate.set(userId, arr);
    return false;
  }

  private broadcast(c: CallRec, ev: string, extra: Record<string, unknown> = {}) {
    const info = this.info(c);
    for (const u of [c.callerId, c.calleeId]) this.d.emitUser(u, ev, { call: info, ...extra });
  }

  async start(callerId: string, calleeId: string, video: boolean): Promise<StartResult> {
    const pol = this.d.policy(callerId, calleeId);
    if (!pol.ok) return { ok: false, error: pol.error, reason: pol.reason };
    // already in a call with this same person (double tap / second tab) → hand back that call
    const mine = this.live.get(callerId);
    if (mine) {
      const c = this.calls.get(mine)!;
      if ((c.callerId === callerId && c.calleeId === calleeId) || (c.calleeId === callerId && c.callerId === calleeId))
        return { ok: true, call: this.info(c), media: await this.media(c, callerId) };
      return { ok: false, error: "You're already in a call", reason: "self_busy" };
    }
    if (this.d.inRoom(callerId)) return { ok: false, error: "Leave the room you're in to start a call", reason: "self_busy" };
    if (this.limited(callerId)) return { ok: false, error: "Slow down a little 🙂 Try again in a few minutes.", reason: "rate" };
    const now = this.now();
    const c: CallRec = {
      id: randomUUID(),
      callerId,
      calleeId,
      video: !!video,
      everVideo: !!video,
      phase: "calling",
      createdAt: now,
      ackAt: null,
      answeredAt: null,
      endedAt: null,
      outcome: null,
      tokens: new Map(),
      timer: null,
      pushed: false,
      orphanSince: null,
      goneSince: new Map(),
    };
    this.calls.set(c.id, c);
    if (this.isBusy(calleeId)) {
      // "Line busy": the caller sees Busy, the callee gets a missed-call message (Telegram behaviour)
      this.finish(c, "busy", { silentToCallee: true });
      return { ok: false, error: `${this.d.peer(calleeId)?.name.split(" ")[0] ?? "They"} is on another call`, reason: "busy", call: this.info(c) };
    }
    this.live.set(callerId, c.id);
    this.live.set(calleeId, c.id);
    // pre-create both LiveKit tokens now (room is created by LiveKit on first join); accept → connect only
    for (const uid of [callerId, calleeId]) c.tokens.set(uid, this.d.mintToken(c.id, uid, this.d.peer(uid)?.name ?? "Guest").catch(() => null));
    c.timer = setTimeout(() => this.timeout(c.id), CALL_RING_TIMEOUT_MS);
    c.timer.unref?.();
    const info = this.info(c);
    const calleeMedia = await this.media(c, calleeId);
    if (c.phase === "ended") return { ok: false, error: "Call ended", reason: "ended", call: this.info(c) };
    this.d.emitUser(calleeId, "call:incoming", { call: info, media: calleeMedia });
    this.d.emitUser(callerId, "call:state", { call: info }); // caller's other tabs show "Calling…"
    if (!this.d.isForeground(calleeId) && this.d.push) {
      c.pushed = true;
      this.d.push.incoming(calleeId, info);
    }
    this.d.log?.("call start", { callId: c.id, video: c.video });
    return { ok: true, call: info, media: await this.media(c, callerId) };
  }

  private get(callId: unknown, userId: string) {
    const c = typeof callId === "string" ? this.calls.get(callId) : undefined;
    if (!c || (c.callerId !== userId && c.calleeId !== userId)) return null;
    return c;
  }

  /** participant view of a call without minting media (decline-token checks, server/calls/api.ts) */
  peek(callId: unknown, userId: string): CallInfo | null {
    const c = this.get(callId, userId);
    return c ? this.info(c) : null;
  }

  /** A callee device got call:incoming and is ringing → caller switches "Calling…" to "Ringing…". */
  ack(callId: unknown, userId: string) {
    const c = this.get(callId, userId);
    if (!c || c.calleeId !== userId) return { ok: false as const, error: "No such call" };
    if (c.phase === "calling") {
      c.phase = "ringing";
      c.ackAt = this.now();
      this.metrics.ringMs.push(c.ackAt - c.createdAt);
      if (this.metrics.ringMs.length > METRIC_KEEP) this.metrics.ringMs.shift();
      this.broadcast(c, "call:state");
    }
    return { ok: true as const, call: this.info(c) };
  }

  async accept(callId: unknown, userId: string) {
    const c = this.get(callId, userId);
    if (!c || c.calleeId !== userId) return { ok: false as const, error: "No such call", reason: "unknown" };
    if (c.phase === "ended") return { ok: false as const, error: "Call ended", reason: "ended", call: this.info(c) };
    if (c.phase !== "active") {
      c.phase = "active";
      c.answeredAt = this.now();
      if (c.timer) clearTimeout(c.timer);
      c.timer = null;
      this.broadcast(c, "call:state");
      if (c.pushed) this.d.push?.cancel(c.calleeId, c.id, "answered");
      this.d.log?.("call accept", { callId: c.id, ringMs: c.answeredAt - c.createdAt });
    }
    return { ok: true as const, call: this.info(c), media: await this.media(c, userId) };
  }

  /** Callee declines while ringing. */
  decline(callId: unknown, userId: string) {
    const c = this.get(callId, userId);
    if (!c || c.calleeId !== userId) return { ok: false as const, error: "No such call" };
    if (c.phase === "active") return this.hangup(callId, userId);
    if (c.phase !== "ended") this.finish(c, "declined");
    return { ok: true as const, call: this.info(c) };
  }

  /** Either side hangs up. Before answer: caller → cancelled (missed for callee), callee → declined. */
  hangup(callId: unknown, userId: string) {
    const c = this.get(callId, userId);
    if (!c) return { ok: false as const, error: "No such call" };
    if (c.phase === "ended") return { ok: true as const, call: this.info(c) };
    if (c.phase === "active") this.finish(c, "completed", { by: userId });
    else this.finish(c, userId === c.callerId ? "cancelled" : "declined");
    return { ok: true as const, call: this.info(c) };
  }

  /** Mid-call camera on/off ("upgrade to video"): relayed to the other side. */
  setVideo(callId: unknown, userId: string, on: boolean) {
    const c = this.get(callId, userId);
    if (!c || c.phase === "ended") return { ok: false as const, error: "No such call" };
    if (on) {
      c.video = true;
      c.everVideo = true;
    }
    const other = userId === c.callerId ? c.calleeId : c.callerId;
    this.d.emitUser(other, "call:video", { callId: c.id, from: userId, on: !!on });
    return { ok: true as const };
  }

  async get_(callId: unknown, userId: string) {
    const c = this.get(callId, userId);
    if (!c) return { ok: false as const, error: "This call isn't available", reason: "unknown" };
    return { ok: true as const, call: this.info(c), media: c.phase === "ended" ? null : await this.media(c, userId) };
  }

  /** client-measured accept → first remote audio (ms) */
  metric(callId: unknown, userId: string, acceptToAudioMs: unknown) {
    const c = this.get(callId, userId);
    const v = Number(acceptToAudioMs);
    if (!c || !Number.isFinite(v) || v <= 0 || v > 60_000) return { ok: false as const };
    this.metrics.acceptToAudioMs.push(Math.round(v));
    if (this.metrics.acceptToAudioMs.length > METRIC_KEEP) this.metrics.acceptToAudioMs.shift();
    this.d.log?.("call metric", { callId: c.id, acceptToAudioMs: Math.round(v), role: userId === c.calleeId ? "callee" : "caller" });
    return { ok: true as const };
  }

  stats() {
    const pct = (a: number[], p: number) => {
      if (!a.length) return null;
      const s = [...a].sort((x, y) => x - y);
      return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
    };
    const a = this.metrics.acceptToAudioMs;
    return {
      live: [...this.calls.values()].filter((c) => c.phase !== "ended").length,
      acceptToAudio: { n: a.length, p50: pct(a, 50), p95: pct(a, 95) },
      ringAck: { n: this.metrics.ringMs.length, p50: pct(this.metrics.ringMs, 50) },
    };
  }

  /** LiveKit says a participant left the call's media room (webhook) */
  mediaLeft(callId: string, userId: string) {
    const c = this.calls.get(callId);
    if (c && c.phase === "active" && (userId === c.callerId || userId === c.calleeId)) this.finish(c, "completed", { by: userId });
  }

  private timeout(callId: string) {
    const c = this.calls.get(callId);
    if (c && (c.phase === "calling" || c.phase === "ringing")) this.finish(c, "missed");
  }

  private finish(c: CallRec, outcome: CallOutcome, opts: { by?: string; silentToCallee?: boolean; reason?: string } = {}) {
    if (c.phase === "ended") return;
    const wasRinging = c.phase !== "active";
    c.phase = "ended";
    c.outcome = outcome;
    c.endedAt = this.now();
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    for (const u of [c.callerId, c.calleeId]) if (this.live.get(u) === c.id) this.live.delete(u);
    const durationSec = c.answeredAt ? Math.max(0, Math.round((c.endedAt - c.answeredAt) / 1000)) : 0;
    if (!opts.silentToCallee) this.broadcast(c, "call:state", { by: opts.by ?? null, ...(opts.reason ? { reason: opts.reason } : {}) });
    else this.d.emitUser(c.callerId, "call:state", { call: this.info(c) });
    if (wasRinging && c.pushed) this.d.push?.cancel(c.calleeId, c.id, outcome === "missed" ? "timeout" : "cancelled");
    this.d.closeMedia(c.id);
    this.d.appendCallMessage({ id: c.id, callerId: c.callerId, video: c.everVideo, outcome, durationSec }, c.calleeId);
    this.d.log?.("call end", { callId: c.id, outcome, durationSec });
  }

  private sweep() {
    const now = this.now();
    for (const c of this.calls.values()) {
      if (c.phase === "ended") {
        if (c.endedAt && now - c.endedAt > ENDED_KEEP_MS) this.calls.delete(c.id);
        continue;
      }
      // ringing and the caller vanished (closed the tab / lost network): cancel instead of ringing on for 45s
      if (c.phase !== "active") {
        if (!this.d.isConnected(c.callerId)) {
          c.orphanSince ??= now;
          if (now - c.orphanSince > CALL_CALLER_GONE_MS) this.finish(c, "cancelled");
        } else c.orphanSince = null;
        continue;
      }
      // active: each side may drop off (no socket) for CALL_RECONNECT_GRACE_MS; the other side is told so it can
      // show "Bea is reconnecting…". Past the grace the call ends as completed (duration kept), never as missed.
      let lost: string | null = null;
      for (const u of [c.callerId, c.calleeId]) {
        const other = u === c.callerId ? c.calleeId : c.callerId;
        if (!this.d.isConnected(u)) {
          if (!c.goneSince.has(u)) {
            c.goneSince.set(u, now);
            this.d.emitUser(other, "call:peer", { callId: c.id, userId: u, online: false, graceMs: CALL_RECONNECT_GRACE_MS });
            this.d.log?.("call peer offline", { callId: c.id });
          } else if (now - c.goneSince.get(u)! > CALL_RECONNECT_GRACE_MS) lost ??= u;
        } else if (c.goneSince.has(u)) {
          this.d.log?.("call peer back", { callId: c.id, offlineMs: now - c.goneSince.get(u)! });
          c.goneSince.delete(u);
          this.d.emitUser(other, "call:peer", { callId: c.id, userId: u, online: true });
        }
      }
      if (lost) {
        this.d.log?.("call lost", { callId: c.id });
        this.finish(c, "completed", { by: lost, reason: "connection_lost" });
        continue;
      }
      // belt and braces: neither side has a socket (both apps killed)
      if (!this.d.isConnected(c.callerId) && !this.d.isConnected(c.calleeId)) {
        c.orphanSince ??= now;
        if (now - c.orphanSince > CALL_ORPHAN_MS) this.finish(c, "completed");
      } else c.orphanSince = null;
    }
  }

  /** test hook */
  _sweep() {
    this.sweep();
  }
}
