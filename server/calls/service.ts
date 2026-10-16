// 1:1 audio/video calls (Telegram-style). Signaling over the existing WebSocket, media over LiveKit (one private
// LiveKit room per call, "openlounge-call-<id>"). Both participants' tokens are minted at RING time, so accepting is
// just "connect" (no extra round trip on the critical accept → first-audio path).
//
// Lifecycle: calling (caller sent call:start) → ringing (a callee device acked) → active (accepted) → ended.
// Outcomes: completed | missed (45s timeout) | declined | cancelled (caller hung up first) | busy | failed.
// Every ended call leaves one service message in the DM (store.appendCallMessage).
import { randomUUID } from "node:crypto";
import type { CallInfo, CallMedia, CallMeta, CallOutcome, CallPeer, CallPhase, TurnIceServer } from "../../src/lib/types";
import type { CallMediaBackend } from "./mediaBackend";

const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && v > 0 ? v : d;
};
export const CALL_RING_TIMEOUT_MS = num("CALL_RING_TIMEOUT_MS", 45_000);
/** No callee device acked call:incoming within this window → send the push anyway (unacked "foreground" socket). */
export const CALL_ACK_FALLBACK_MS = num("CALL_ACK_FALLBACK_MS", 4_000);
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
/** Active call where one side is still online (other tab/device/socket) but no connection of theirs is in the call
 *  any more (call page closed, app killed while a chat socket lingers): end it so it can't block every new call. */
export const CALL_DETACHED_MS = num("CALL_DETACHED_MS", 60_000);
export const CALL_MAX_PER_10MIN = num("CALL_MAX_PER_10MIN", 12);
/**
 * Lifetime of a call's LiveKit join token (the call's media credential). Short on purpose: it only has to cover
 * ring → accept → connect (ring ≤ 45 s). Once connected, LiveKit keeps the client on server-refreshed tokens (sent right
 * after join and every few minutes, ~10 min validity), so resume and LiveKit's own full reconnect work in calls of any
 * length (verified against livekit-server 1.13: /workspace/calls/token-ttl). Our own rejoin asks call:get, which re-mints
 * while the call is live. After the call ends nothing is re-minted, and a join with a still-valid refreshed token into an
 * ended call's room is kicked by the LiveKit webhook guard (calls/index.ts) — the credential dies with the call.
 */
export const CALL_TOKEN_TTL_S = num("CALL_TOKEN_TTL_S", 180);
/** ended calls answer call:get ("Call ended") — and keep the webhook guard armed — for a while: longer than a
 *  LiveKit-refreshed token stays valid (10 min) plus LiveKit's 1 min clock leeway */
const ENDED_KEEP_MS = 12 * 60_000;
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
  /** Preferred backend for a NEW call. The selected instance is retained on the call record. */
  /** Chooses the media backend for a new call; receives both participants so a server-side test allowlist can opt them in. */
  selectMedia?(participants?: { callerId: string; calleeId: string }): CallMediaBackend | null;
  /** Existing LiveKit path for compatibility and layered Mediasoup fallback. */
  liveKitFallback?(): CallMediaBackend | null;
  /** Legacy LiveKit hooks retained for focused unit tests and older integration wiring. */
  mintToken?(callId: string, userId: string, name: string, ttlSec: number): Promise<string | null>;
  mediaUrl?(): string | null;
  /** Optional self-hosted TURN credentials; this remains untouched when no secret is configured. */
  turnIceServers?(callId: string, userId: string): TurnIceServer[] | null;
  closeMedia?(callId: string): void;
  push?: {
    incoming(calleeId: string, call: CallInfo): void;
    cancel(calleeId: string, callId: string, reason: string): void;
  };
  now?(): number;
  /** number of live sockets for a user (ring-delivery diagnostics only) */
  connCount?(userId: string): number;
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
  /** socket that answered (multi-device first-accept-wins) */
  answeredConn?: string | null;
  endedAt: number | null;
  outcome: CallOutcome | null;
  /** per participant: the current backend credential (re-minted by media() once it's past half its lifetime) */
  tokens: Map<string, { p: Promise<CallMedia | null>; at: number }>;
  /** Captured once at call start; only `fallbackMedia()` may replace it, and only Mediasoup → LiveKit. */
  backend: CallMediaBackend;
  /** The original direct-UDP backend, retained after a TCP fallback so `restoreMedia()` can return to it. */
  primary?: CallMediaBackend | null;
  /** last backend switch (fallback or restore): server-side hysteresis against flapping */
  switchedAt?: number;
  timer: NodeJS.Timeout | null;
  pushed: boolean;
  orphanSince: number | null;
  /** active call: when each participant lost their last socket (reconnect grace) */
  goneSince: Map<string, number>;
  /** per participant: when their last in-call connection closed while they stayed online elsewhere */
  detachedSince?: Map<string, number>;
  /** connections (socket ids) that are actually in this call per participant: bound by start/accept/get/media, dropped on close */
  conns: Map<string, Set<string>>;
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

  private legacyLiveKit(): CallMediaBackend | null {
    const url = this.d.mediaUrl?.();
    const mint = this.d.mintToken;
    if (!url || !mint) return null;
    return {
      provider: "livekit",
      issue: async ({ callId, userId, name, ttlSec }) => {
        const token = await mint(callId, userId, name, ttlSec);
        const iceServers = this.d.turnIceServers?.(callId, userId);
        return token ? { provider: "livekit", url, token, expiresAt: Math.floor(this.now() / 1000) + ttlSec, ...(iceServers ? { iceServers } : {}) } : null;
      },
      close: (callId) => this.d.closeMedia?.(callId),
    };
  }

  private selectBackend(participants?: { callerId: string; calleeId: string }) {
    return this.d.selectMedia?.(participants) ?? this.legacyLiveKit();
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

  private mint(c: CallRec, userId: string) {
    const t = { p: c.backend.issue({ callId: c.id, userId, name: this.d.peer(userId)?.name ?? "Guest", ttlSec: CALL_TOKEN_TTL_S }).catch(() => null), at: this.now() };
    c.tokens.set(userId, t);
    return t;
  }

  /** media credential for a participant of a LIVE call (never for an ended one); fresh enough to connect with */
  private async media(c: CallRec, userId: string): Promise<CallMedia | null> {
    if (c.phase === "ended" || (userId !== c.callerId && userId !== c.calleeId)) return null;
    // The caller may establish its outbound UDP transport while ringing, but the called party never receives a
    // Mediasoup admission token (nor can it use one) before explicitly accepting the call.
    if (c.backend.provider === "mediasoup" && userId === c.calleeId && c.phase !== "active") return null;
    let t = c.tokens.get(userId);
    if (!t || this.now() - t.at > (CALL_TOKEN_TTL_S * 1000) / 2) t = this.mint(c, userId);
    const media = await t.p;
    return media && (c.phase as CallPhase) !== "ended" ? media : null;
  }

  /**
   * LiveKit webhook guard: may this identity be in this call's media room right now? false = the call ended (or the
   * identity isn't one of its two participants) → kick. null = unknown call (e.g. the app server restarted): leave it.
   */
  mediaAllowed(callId: string, userId: string): boolean | null {
    const c = this.calls.get(callId);
    if (!c) return null;
    return c.phase !== "ended" && (userId === c.callerId || userId === c.calleeId);
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

  private bind(c: CallRec, userId: string, connId?: string) {
    if (!connId || c.phase === "ended") return;
    let set = c.conns.get(userId);
    if (!set) c.conns.set(userId, (set = new Set()));
    set.add(connId);
  }

  /** A socket closed: it is no longer in any call. */
  connClosed(connId: string, userId: string) {
    const id = this.live.get(userId);
    const c = id ? this.calls.get(id) : undefined;
    c?.conns.get(userId)?.delete(connId);
  }

  /** An ACTIVE call whose other participant once joined from a connection and has none left in the call (page/app gone,
   *  possibly already back with a fresh page that doesn't know the call). Re-dialing must not re-attach to it. */
  private staleFor(c: CallRec, userId: string) {
    if (c.phase !== "active") return false;
    const other = c.callerId === userId ? c.calleeId : c.callerId;
    const set = c.conns.get(other);
    return !!set && set.size === 0;
  }

  async start(callerId: string, calleeId: string, video: boolean, connId?: string): Promise<StartResult> {
    const pol = this.d.policy(callerId, calleeId);
    if (!pol.ok) return { ok: false, error: pol.error, reason: pol.reason };
    // already in a call with this same person (double tap / second tab) → hand back that call
    const mine = this.live.get(callerId);
    if (mine) {
      const c = this.calls.get(mine)!;
      const samePair = (c.callerId === callerId && c.calleeId === calleeId) || (c.calleeId === callerId && c.callerId === calleeId);
      if (samePair && this.staleFor(c, callerId)) {
        // re-dial during the reconnect grace while the other side's page is gone: end the stale call, ring fresh
        this.d.log?.("call stale redial", { callId: c.id });
        this.finish(c, "completed", { by: c.callerId === callerId ? c.calleeId : c.callerId, reason: "connection_lost" });
      } else if (samePair) {
        this.bind(c, callerId, connId);
        return { ok: true, call: this.info(c), media: await this.media(c, callerId) };
      } else return { ok: false, error: "You're already in a call", reason: "self_busy" };
    }
    if (this.d.inRoom(callerId)) return { ok: false, error: "Leave the room you're in to start a call", reason: "self_busy" };
    if (this.limited(callerId)) return { ok: false, error: "Slow down a little 🙂 Try again in a few minutes.", reason: "rate" };
    const backend = this.selectBackend({ callerId, calleeId });
    if (!backend) return { ok: false, error: "Calls aren't available right now", reason: "media_unavailable" };
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
      backend,
      timer: null,
      pushed: false,
      orphanSince: null,
      goneSince: new Map(),
      conns: new Map(),
    };
    this.calls.set(c.id, c);
    if (this.isBusy(calleeId)) {
      // "Line busy": the caller sees Busy, the callee gets a missed-call message (Telegram behaviour)
      this.finish(c, "busy", { silentToCallee: true });
      return { ok: false, error: `${this.d.peer(calleeId)?.name.split(" ")[0] ?? "They"} is on another call`, reason: "busy", call: this.info(c) };
    }
    this.live.set(callerId, c.id);
    this.live.set(calleeId, c.id);
    this.bind(c, callerId, connId);
    // Preserve ring-time prewarming for the established LiveKit path. For direct UDP, only the caller has a
    // credential until the callee atomically accepts; the server enforces that consent boundary below as well.
    this.mint(c, callerId);
    if (backend.provider === "livekit") this.mint(c, calleeId);
    c.timer = setTimeout(() => this.timeout(c.id), CALL_RING_TIMEOUT_MS);
    c.timer.unref?.();
    const info = this.info(c);
    const calleeMedia = await this.media(c, calleeId);
    if (c.phase === "ended") return { ok: false, error: "Call ended", reason: "ended", call: this.info(c) };
    this.d.emitUser(calleeId, "call:incoming", { call: info, media: calleeMedia });
    this.d.log?.("call ring emit", { callId: c.id, calleeSockets: this.d.connCount?.(calleeId) ?? null, foreground: this.d.isForeground(calleeId) });
    this.d.emitUser(callerId, "call:state", { call: info }); // caller's other tabs show "Calling…"
    if (!this.d.isForeground(calleeId) && this.d.push) {
      c.pushed = true;
      this.d.push.incoming(calleeId, info);
    } else if (this.d.push) {
      // A "foreground" socket that never acks (frozen/unattended tab, stale WebView) used to mean no ring anywhere
      // for the full 45 s. If no callee device acks in time, fall back to push so their phone still rings.
      const t = setTimeout(() => {
        if (c.phase !== "calling" || c.pushed || !this.d.push) return;
        c.pushed = true;
        this.d.log?.("call ack fallback push", { callId: c.id, calleeSockets: this.d.connCount?.(calleeId) ?? null });
        this.d.push.incoming(calleeId, info);
      }, CALL_ACK_FALLBACK_MS);
      t.unref?.();
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
      this.d.log?.("call ring ack", { callId: c.id, ms: c.ackAt - c.createdAt });
      this.metrics.ringMs.push(c.ackAt - c.createdAt);
      if (this.metrics.ringMs.length > METRIC_KEEP) this.metrics.ringMs.shift();
      this.broadcast(c, "call:state");
    }
    return { ok: true as const, call: this.info(c) };
  }

  async accept(callId: unknown, userId: string, connId?: string) {
    const c = this.get(callId, userId);
    if (!c || c.calleeId !== userId) return { ok: false as const, error: "No such call", reason: "unknown" };
    if (c.phase === "ended") return { ok: false as const, error: "Call ended", reason: "ended", call: this.info(c) };
    // Same account on several devices: the FIRST accept wins. A different, still-connected socket of the callee that
    // accepts afterwards (simultaneous tap) is told it was answered elsewhere and gets no media credential. The same
    // device re-accepting after a reconnect is allowed (its old socket is gone from the call's connection set).
    if (c.phase === "active" && connId && c.answeredConn && c.answeredConn !== connId && c.conns.get(userId)?.has(c.answeredConn))
      return { ok: false as const, error: "Answered on another device", reason: "answered_elsewhere", call: this.info(c) };
    this.bind(c, userId, connId);
    if (c.phase !== "active") {
      c.phase = "active";
      c.answeredConn = connId ?? null;
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

  async get_(callId: unknown, userId: string, connId?: string) {
    const c = this.get(callId, userId);
    if (!c) return { ok: false as const, error: "This call isn't available", reason: "unknown" };
    this.bind(c, userId, connId);
    return { ok: true as const, call: this.info(c), media: c.phase === "ended" ? null : await this.media(c, userId) };
  }

  /**
   * The only in-call backend migration: a failed or degraded Mediasoup transport moves BOTH participants to the
   * established LiveKit/TCP backend. The new credential is broadcast, and clients rebuild media automatically.
   */
  async fallbackMedia(callId: unknown, userId: string) {
    const c = this.get(callId, userId);
    if (!c || c.phase === "ended") return { ok: false as const, error: "This call isn't available" };
    if (c.backend.provider === "livekit") return { ok: true as const, call: this.info(c), media: await this.media(c, userId), alreadyFallback: true };
    const fallback = this.d.liveKitFallback?.() ?? this.legacyLiveKit();
    if (!fallback) return { ok: false as const, error: "TCP fallback isn't available" };
    c.primary = c.backend;
    c.switchedAt = this.now();
    c.backend.close(c.id);
    c.backend = fallback;
    c.tokens.clear();
    for (const uid of [c.callerId, c.calleeId]) this.mint(c, uid);
    const info = this.info(c);
    const all = await Promise.all([c.callerId, c.calleeId].map(async (uid) => [uid, await this.media(c, uid)] as const));
    for (const [uid, media] of all) this.d.emitUser(uid, "call:mediaFallback", { call: info, media, from: "mediasoup", to: "livekit" });
    this.d.log?.("call media fallback", { callId: c.id, from: "mediasoup", to: "livekit" });
    return { ok: true as const, call: info, media: all.find(([uid]) => uid === userId)?.[1] ?? null };
  }

  /**
   * Return to direct UDP after a TCP fallback. Only an active call that started on Mediasoup may go back, and never
   * sooner than CALL_RESTORE_MIN_MS after the last switch (hysteresis). If UDP fails again the client simply calls
   * `fallbackMedia()`, which is unchanged.
   */
  async restoreMedia(callId: unknown, userId: string) {
    const c = this.get(callId, userId);
    if (!c || c.phase !== "active") return { ok: false as const, error: "This call isn't active" };
    if (c.backend.provider === "mediasoup") return { ok: true as const, call: this.info(c), media: await this.media(c, userId), alreadyUdp: true };
    if (!c.primary || c.primary.provider !== "mediasoup") return { ok: false as const, error: "UDP media isn't available" };
    const minGap = num("CALL_RESTORE_MIN_MS", 10_000);
    if (c.switchedAt && this.now() - c.switchedAt < minGap) return { ok: false as const, error: "Too soon", retryInMs: minGap - (this.now() - c.switchedAt) };
    const tcp = c.backend;
    c.backend = c.primary;
    c.switchedAt = this.now();
    c.tokens.clear();
    for (const uid of [c.callerId, c.calleeId]) this.mint(c, uid);
    const info = this.info(c);
    const all = await Promise.all([c.callerId, c.calleeId].map(async (uid) => [uid, await this.media(c, uid)] as const));
    if (all.some(([, m]) => !m || m.provider !== "mediasoup")) {
      // UDP credential couldn't be issued: stay on the working TCP path.
      c.backend = tcp;
      c.tokens.clear();
      for (const uid of [c.callerId, c.calleeId]) this.mint(c, uid);
      return { ok: false as const, error: "UDP media isn't available" };
    }
    tcp.close(c.id);
    for (const [uid, media] of all) this.d.emitUser(uid, "call:mediaRestore", { call: info, media, from: "livekit", to: "mediasoup" });
    this.d.log?.("call media restore", { callId: c.id, from: "livekit", to: "mediasoup" });
    return { ok: true as const, call: info, media: all.find(([uid]) => uid === userId)?.[1] ?? null };
  }

  /** Broker an authenticated browser signaling action to the currently selected Mediasoup backend. */
  async mediaRequest(callId: unknown, userId: string, connectionId: string, method: string, payload: Record<string, unknown>) {
    const c = this.get(callId, userId);
    if (!c || c.phase === "ended" || c.backend.provider !== "mediasoup" || !c.backend.relay) return { ok: false as const, error: "UDP media isn't available" };
    if (userId === c.calleeId && c.phase !== "active") return { ok: false as const, error: "Answer the call before joining direct media" };
    this.bind(c, userId, connectionId);
    const media = await this.media(c, userId);
    if (!media || media.provider !== "mediasoup") return { ok: false as const, error: "UDP media credential expired" };
    const result = await c.backend.relay({ callId: c.id, userId, connectionId, method, payload, token: media.token });
    return { ok: true as const, result };
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
    if (c && (c.phase === "calling" || c.phase === "ringing")) {
      this.d.log?.("call ring timeout", { callId: c.id, acked: c.phase === "ringing", calleeSockets: this.d.connCount?.(c.calleeId) ?? null });
      this.finish(c, "missed");
    }
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
    c.tokens.clear(); // the media credential dies with the call: nothing is handed out or re-minted after this
    const durationSec = c.answeredAt ? Math.max(0, Math.round((c.endedAt - c.answeredAt) / 1000)) : 0;
    if (!opts.silentToCallee) this.broadcast(c, "call:state", { by: opts.by ?? null, ...(opts.reason ? { reason: opts.reason } : {}) });
    else this.d.emitUser(c.callerId, "call:state", { call: this.info(c) });
    if (wasRinging && c.pushed) this.d.push?.cancel(c.calleeId, c.id, outcome === "missed" ? "timeout" : "cancelled");
    c.backend.close(c.id);
    this.d.appendCallMessage({ id: c.id, callerId: c.callerId, video: c.everVideo, outcome, durationSec }, c.calleeId);
    this.d.log?.("call end", { callId: c.id, outcome, durationSec, by: opts.by === c.callerId ? "caller" : opts.by === c.calleeId ? "callee" : (opts.by ?? null), reason: opts.reason ?? null });
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
      for (const u of [c.callerId, c.calleeId]) {
        const set = c.conns.get(u);
        if (set && set.size === 0 && this.d.isConnected(u)) {
          if (!c.detachedSince) c.detachedSince = new Map();
          if (!c.detachedSince.has(u)) c.detachedSince.set(u, now);
          else if (now - c.detachedSince.get(u)! > CALL_DETACHED_MS) lost ??= u;
        } else c.detachedSince?.delete(u);
      }
      if (lost) {
        this.d.log?.("call detached", { callId: c.id });
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
