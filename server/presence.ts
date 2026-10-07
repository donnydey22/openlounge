// Online presence: who has Open Lounge open right now — green / amber / no dot.
//
//   online  — at least one authenticated WebSocket connection is in the foreground (the client
//             reports document.visibilityState via "presence:visible") or is seated in a live room
//             (listening with the app backgrounded still counts as active).
//   away    — still connected, but every connection is backgrounded / hidden (amber dot).
//   offline — no connection left (no dot).
// Multi-tab / multi-device aware: every connection is tracked individually, so closing one
// tab or device never marks the user offline while another one is still active.
//
// Changes are debounced so a page refresh / quick reconnect doesn't flicker:
//   socket closed (or killed by the server heartbeat) → offline after CLOSE_GRACE_MS
//   app backgrounded (visibilitychange → hidden)     → away after AWAY_GRACE_MS
// Changes are pushed to every signed-in socket as
//   "presence:update" { userId, online, status, lastSeenAt }
// (`online` stays the legacy boolean = status === "online"; `status` is additive.)
// "Last seen" comes from sessions.last_seen_at (already persisted), so it survives restarts.

import type { WsHub } from "./ws";

export const PRESENCE_CHANNEL = "presence";
const envMs = (name: string, dflt: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
export const CLOSE_GRACE_MS = envMs("PRESENCE_CLOSE_GRACE_MS", 4_000);
export const HIDDEN_GRACE_MS = envMs("PRESENCE_HIDDEN_GRACE_MS", 30_000);
/** foreground → background: amber after this (short, so the dot follows the tab quickly but a quick app switch doesn't blink) */
export const AWAY_GRACE_MS = envMs("PRESENCE_AWAY_GRACE_MS", 1_500);
const SWEEP_MS = 15_000;

interface ConnState {
  userId: string;
  token: string;
  visible: boolean;
}

export type PresenceStatus = "online" | "away" | "offline";

export interface PresenceUpdate {
  userId: string;
  /** legacy boolean (true only while "online") */
  online: boolean;
  status: PresenceStatus;
  /** when the user was last active (null while online / never seen) */
  lastSeenAt: number | null;
}

export class Presence {
  private conns = new Map<string, ConnState>(); // connId → state
  private byUser = new Map<string, Set<string>>(); // userId → connIds
  /** users with a non-offline status (online or away) */
  private status = new Map<string, Exclude<PresenceStatus, "offline">>();
  private departed = new Map<string, { at: number; token: string }>();
  private timers = new Map<string, { t: NodeJS.Timeout; at: number; to: PresenceStatus }>();

  constructor(
    private io: WsHub,
    /** is this connection currently seated in a live room? */
    private inRoom: (connId: string) => boolean,
    /** persist a last-seen timestamp against the session token */
    private persistLastSeen: (token: string, at: number) => void,
    private lastSeen: Map<string, number> = new Map(),
  ) {
    // Catch state changes that don't come with an explicit event (room ended while backgrounded, …)
    setInterval(() => {
      for (const userId of [...this.status.keys()]) this.update(userId);
    }, SWEEP_MS).unref();
  }

  isOnline(userId: string) {
    return this.status.get(userId) === "online";
  }

  statusOf(userId: string): PresenceStatus {
    return this.status.get(userId) ?? "offline";
  }

  lastSeenAt(userId: string): number | null {
    return this.isOnline(userId) ? null : (this.lastSeen.get(userId) ?? null);
  }

  connectionCount(userId: string) {
    return this.byUser.get(userId)?.size ?? 0;
  }

  snapshot() {
    const onlineIds: string[] = [];
    const awayIds: string[] = [];
    for (const [id, st] of this.status) (st === "online" ? onlineIds : awayIds).push(id);
    return { onlineIds, awayIds, lastSeen: Object.fromEntries(this.lastSeen) };
  }

  /** A connection authenticated as userId (login, signup or session resume). */
  attach(connId: string, userId: string, token: string) {
    const existing = this.conns.get(connId);
    if (existing && existing.userId !== userId) this.detach(connId, 0);
    const c = this.conns.get(connId);
    if (c) {
      c.token = token;
    } else {
      this.conns.set(connId, { userId, token, visible: true });
      let set = this.byUser.get(userId);
      if (!set) this.byUser.set(userId, (set = new Set()));
      set.add(connId);
    }
    this.update(userId);
  }

  /** Connection closed / logged out. */
  detach(connId: string, graceMs = CLOSE_GRACE_MS) {
    const c = this.conns.get(connId);
    if (!c) return;
    const wasActive = c.visible || this.inRoom(connId);
    this.conns.delete(connId);
    const set = this.byUser.get(c.userId);
    set?.delete(connId);
    if (set && set.size === 0) this.byUser.delete(c.userId);
    if (wasActive && !this.active(c.userId)) this.departed.set(c.userId, { at: Date.now(), token: c.token });
    this.update(c.userId, graceMs);
  }

  /** Client reported foreground/background (document.visibilityState). */
  setVisible(connId: string, visible: boolean) {
    const c = this.conns.get(connId);
    if (!c || c.visible === visible) return;
    c.visible = visible;
    if (!visible && !this.active(c.userId)) this.departed.set(c.userId, { at: Date.now(), token: c.token });
    this.update(c.userId);
  }

  /** Re-evaluate after something that affects activity (room join/leave). */
  refresh(userId: string) {
    this.update(userId);
  }

  private active(userId: string) {
    for (const connId of this.byUser.get(userId) ?? []) {
      const c = this.conns.get(connId);
      if (c && (c.visible || this.inRoom(connId))) return true;
    }
    return false;
  }

  private target(userId: string): PresenceStatus {
    if (this.active(userId)) return "online";
    return (this.byUser.get(userId)?.size ?? 0) > 0 ? "away" : "offline";
  }

  /**
   * Move toward the status the connections imply. Becoming online is immediate; online → away waits
   * AWAY_GRACE_MS; anything → offline waits `closeGraceMs` (page refresh / quick reconnect).
   */
  private update(userId: string, closeGraceMs = CLOSE_GRACE_MS) {
    const to = this.target(userId);
    const cur = this.statusOf(userId);
    const pending = this.timers.get(userId);
    if (to === cur) {
      if (pending) clearTimeout(pending.t);
      this.timers.delete(userId);
      if (to === "online") this.departed.delete(userId);
      return;
    }
    if (to === "online" || (to === "away" && cur === "offline")) {
      if (pending) clearTimeout(pending.t);
      this.timers.delete(userId);
      this.apply(userId, to);
      return;
    }
    const graceMs = to === "away" ? AWAY_GRACE_MS : closeGraceMs;
    const at = Date.now() + graceMs;
    if (pending && pending.to === to && pending.at <= at) return; // already scheduled sooner
    if (pending) clearTimeout(pending.t);
    const t = setTimeout(() => {
      this.timers.delete(userId);
      const now = this.target(userId);
      if (now !== this.statusOf(userId)) this.apply(userId, now);
    }, graceMs);
    t.unref();
    this.timers.set(userId, { t, at, to });
  }

  private apply(userId: string, to: PresenceStatus) {
    const was = this.statusOf(userId);
    if (to === was) return;
    if (to === "offline") this.status.delete(userId);
    else this.status.set(userId, to);
    let lastSeenAt: number | null = null;
    if (to === "online") {
      this.departed.delete(userId);
    } else if (was === "online" || !this.lastSeen.has(userId)) {
      // stopped being active: record "last seen"
      const d = this.departed.get(userId);
      const at = d?.at ?? Date.now();
      this.lastSeen.set(userId, at);
      const token = d?.token ?? [...(this.byUser.get(userId) ?? [])].map((id) => this.conns.get(id)?.token).find(Boolean);
      if (token) this.persistLastSeen(token, at);
      lastSeenAt = at;
    } else {
      lastSeenAt = this.lastSeen.get(userId) ?? null;
    }
    if (to === "offline") this.departed.delete(userId);
    this.broadcast({ userId, online: to === "online", status: to, lastSeenAt });
  }

  private broadcast(u: PresenceUpdate) {
    this.io.to(PRESENCE_CHANNEL).emit("presence:update", u);
  }
}
