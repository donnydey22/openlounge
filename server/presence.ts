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
//   backgrounded app whose socket died               → offline after HIDDEN_GRACE_MS (was 120 s, now 2 s)
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
export const CLOSE_GRACE_MS = envMs("PRESENCE_CLOSE_GRACE_MS", 1_500);
/** a connection that was already backgrounded when it closed (phone app frozen/killed by the OS) stays "away" this long */
export const HIDDEN_GRACE_MS = envMs("PRESENCE_HIDDEN_GRACE_MS", 2_000);
/** foreground → background: amber after this (short, so the dot follows the tab quickly but a quick app switch doesn't blink) */
export const AWAY_GRACE_MS = envMs("PRESENCE_AWAY_GRACE_MS", 1_500);
/** safety-net re-evaluation (cheap: only walks non-offline users) */
/** generic ws interaction while away/offline: at most one persist+broadcast per user per this window */
export const ACTIVITY_THROTTLE_MS = envMs("PRESENCE_ACTIVITY_THROTTLE_MS", 10_000);
export const SWEEP_MS = envMs("PRESENCE_SWEEP_MS", 2_000);
/** A reconnect must remain explicitly foreground for this long before it can announce hallway presence. */
export const HALLWAY_ONLINE_GRACE_MS = envMs("PRESENCE_HALLWAY_ONLINE_GRACE_MS", 30_000);

interface ConnState {
  userId: string;
  token: string;
  /** false until the browser/native shell explicitly reports document/app visibility after auth */
  visibilityConfirmed: boolean;
  visible: boolean;
}

export type PresenceStatus = "online" | "away" | "offline";

export interface PresenceUpdate {
  userId: string;
  /** legacy boolean (true only while "online") */
  online: boolean;
  status: PresenceStatus;
  /** when the user was last active (null while online / never seen) — server epoch ms, the ONLY last-seen value */
  lastSeenAt: number | null;
  /** server clock when this was sent (client clock-skew correction) */
  now: number;
}

export class Presence {
  private conns = new Map<string, ConnState>(); // connId → state
  private byUser = new Map<string, Set<string>>(); // userId → connIds
  /** users with a non-offline status (online or away) */
  private status = new Map<string, Exclude<PresenceStatus, "offline">>();
  private departed = new Map<string, { at: number; token: string }>();
  private timers = new Map<string, { t: NodeJS.Timeout; at: number; to: PresenceStatus }>();
  private hallwayTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private io: WsHub,
    /** is this connection currently seated in a live room? */
    private inRoom: (connId: string) => boolean,
    /** persist a last-seen timestamp against the session token */
    private persistLastSeen: (token: string, at: number) => void,
    private lastSeen: Map<string, number> = new Map(),
    /** hallway presence: fired after a newly-online user remains explicitly foreground through the stability window */
    private onBecameOnline: ((userId: string) => void) | null = null,
  ) {
    // Catch state changes that don't come with an explicit event (room ended while backgrounded, …)
    this.sweep = setInterval(() => {
      for (const userId of [...this.status.keys()]) this.update(userId);
    }, Math.max(250, SWEEP_MS));
    this.sweep.unref();
  }
  private sweep: NodeJS.Timeout;

  stop() {
    clearInterval(this.sweep);
    for (const p of this.timers.values()) clearTimeout(p.t);
    this.timers.clear();
    for (const t of this.hallwayTimers.values()) clearTimeout(t);
    this.hallwayTimers.clear();
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
    // last seen only for users who are NOT online (an online user's old value would be a stale cache on the client)
    const lastSeen: Record<string, number> = {};
    for (const [id, at] of this.lastSeen) if (this.status.get(id) !== "online") lastSeen[id] = at;
    return { onlineIds, awayIds, lastSeen, now: Date.now() };
  }

  /** A connection authenticated as userId (login, signup or session resume). */
  attach(connId: string, userId: string, token: string) {
    const existing = this.conns.get(connId);
    if (existing && existing.userId !== userId) this.detach(connId, 0);
    const c = this.conns.get(connId);
    if (c) {
      c.token = token;
    } else {
      // A new socket must not be assumed foreground. Native WebViews can reconnect while the app is
      // backgrounded, and a server-side default of `visible: true` produced false green hallway dots.
      // The client confirms its real state immediately after session resume via presence:visible.
      this.conns.set(connId, { userId, token, visible: false, visibilityConfirmed: false });
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
    if (!this.hasConfirmedForeground(c.userId)) this.cancelHallwayPresence(c.userId);
    if (wasActive && !this.active(c.userId)) this.departed.set(c.userId, { at: Date.now(), token: c.token });
    // backgrounded app whose socket died: keep the amber dot for a while instead of flipping to offline
    this.update(c.userId, !wasActive && graceMs === CLOSE_GRACE_MS ? Math.max(graceMs, HIDDEN_GRACE_MS) : graceMs);
  }

  /** Client reported foreground/background (document.visibilityState). */
  setVisible(connId: string, visible: boolean) {
    const c = this.conns.get(connId);
    if (!c) return;
    const changed = c.visible !== visible || !c.visibilityConfirmed;
    c.visibilityConfirmed = true;
    if (!changed) return;
    c.visible = visible;
    if (!visible && !this.hasConfirmedForeground(c.userId)) this.cancelHallwayPresence(c.userId);
    if (!visible && !this.active(c.userId)) this.departed.set(c.userId, { at: Date.now(), token: c.token });
    this.update(c.userId);
  }

  /**
   * The user did something (sent / read a DM, …) on connection `connId`. If they aren't shown as online (e.g. a
   * backgrounded native app marking a message read), move "last seen" forward so it can never be older than a
   * read receipt / message they produced — the relative and absolute times stay congruent.
   */
  activity(userId: string, at = Date.now(), throttleMs = 0) {
    if (this.isOnline(userId)) return;
    const prev = this.lastSeen.get(userId) ?? 0;
    if (at <= prev || at - prev < throttleMs) return;
    this.lastSeen.set(userId, at);
    const token = [...(this.byUser.get(userId) ?? [])].map((id) => this.conns.get(id)?.token).find(Boolean);
    if (token) this.persistLastSeen(token, at);
    this.broadcast({ userId, online: false, status: this.statusOf(userId), lastSeenAt: at, now: Date.now() });
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

  /** A backgrounded-but-connected app is away only after it reported its visibility at least once. */
  private hasConfirmedConnection(userId: string) {
    for (const connId of this.byUser.get(userId) ?? []) if (this.conns.get(connId)?.visibilityConfirmed) return true;
    return false;
  }

  /** Hallway notices require a confirmed foreground connection, never just a socket reconnect. */
  private hasConfirmedForeground(userId: string) {
    for (const connId of this.byUser.get(userId) ?? []) {
      const c = this.conns.get(connId);
      if (c?.visibilityConfirmed && c.visible) return true;
    }
    return false;
  }

  private cancelHallwayPresence(userId: string) {
    const t = this.hallwayTimers.get(userId);
    if (t) clearTimeout(t);
    this.hallwayTimers.delete(userId);
  }

  private scheduleHallwayPresence(userId: string) {
    this.cancelHallwayPresence(userId);
    const t = setTimeout(() => {
      this.hallwayTimers.delete(userId);
      if (this.statusOf(userId) !== "online" || !this.hasConfirmedForeground(userId)) return;
      try {
        this.onBecameOnline?.(userId);
      } catch (e) {
        console.warn("[presence] onBecameOnline failed:", (e as Error).message);
      }
    }, HALLWAY_ONLINE_GRACE_MS);
    t.unref();
    this.hallwayTimers.set(userId, t);
  }

  private target(userId: string): PresenceStatus {
    if (this.active(userId)) return "online";
    // Do not render a dot until the client has explicitly told us whether it is visible. This is
    // especially important after an iOS/Android WebView reconnects while its app is backgrounded.
    return this.hasConfirmedConnection(userId) ? "away" : "offline";
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
    // a routine re-evaluation (sweep, room refresh) never shortens a pending backgrounded-app grace; only an
    // explicit fast path (logout: grace 0) does
    if (pending && pending.to === to && closeGraceMs >= CLOSE_GRACE_MS) return;
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
    if (to !== "online") this.cancelHallwayPresence(userId);
    let lastSeenAt: number | null = null;
    if (to === "online") {
      this.departed.delete(userId);
    } else if (was === "online" || !this.lastSeen.has(userId)) {
      // stopped being active: record "last seen"
      const d = this.departed.get(userId);
      // never move backwards (seeded value from sessions.last_seen_at or an activity bump may be newer)
      const at = Math.max(d?.at ?? Date.now(), this.lastSeen.get(userId) ?? 0);
      this.lastSeen.set(userId, at);
      const token = d?.token ?? [...(this.byUser.get(userId) ?? [])].map((id) => this.conns.get(id)?.token).find(Boolean);
      if (token) this.persistLastSeen(token, at);
      lastSeenAt = at;
    } else {
      lastSeenAt = this.lastSeen.get(userId) ?? null;
    }
    if (to === "offline") this.departed.delete(userId);
    this.broadcast({ userId, online: to === "online", status: to, lastSeenAt, now: Date.now() });
    // Hallway presence: only after an explicitly foreground client stays newly online through the
    // stability window. A raw WebSocket reconnect, a brief connectivity flap, or an in-room socket
    // that never confirmed foreground visibility is not a hallway visit.
    if (to === "online" && was !== "online" && this.hasConfirmedForeground(userId)) {
      this.scheduleHallwayPresence(userId);
    }
  }

  private broadcast(u: PresenceUpdate) {
    this.io.to(PRESENCE_CHANNEL).emit("presence:update", u);
  }
}
