// Online presence: who has Open Lounge open right now.
//
// A user is online while at least one of their authenticated WebSocket connections is
//   • foreground (the client reports document.visibilityState via "presence:visible"), or
//   • sitting in a live room (listening with the app backgrounded still counts).
// Multi-tab / multi-device aware: every connection is tracked individually, so closing one
// tab or device never marks the user offline while another one is still active.
//
// Offline is debounced so a page refresh / quick reconnect doesn't flicker:
//   socket closed (or killed by the server heartbeat) → offline after CLOSE_GRACE_MS
//   app backgrounded (visibilitychange → hidden)     → offline after HIDDEN_GRACE_MS
// Changes are pushed to every signed-in socket as "presence:update" { userId, online, lastSeenAt }.
// "Last seen" comes from sessions.last_seen_at (already persisted), so it survives restarts.

import type { WsHub } from "./ws";

export const PRESENCE_CHANNEL = "presence";
const envMs = (name: string, dflt: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
export const CLOSE_GRACE_MS = envMs("PRESENCE_CLOSE_GRACE_MS", 4_000);
export const HIDDEN_GRACE_MS = envMs("PRESENCE_HIDDEN_GRACE_MS", 30_000);
const SWEEP_MS = 15_000;

interface ConnState {
  userId: string;
  token: string;
  visible: boolean;
}

export interface PresenceUpdate {
  userId: string;
  online: boolean;
  /** when the user was last active (null while online / never seen) */
  lastSeenAt: number | null;
}

export class Presence {
  private conns = new Map<string, ConnState>(); // connId → state
  private byUser = new Map<string, Set<string>>(); // userId → connIds
  private online = new Set<string>();
  private departed = new Map<string, { at: number; token: string }>();
  private timers = new Map<string, { t: NodeJS.Timeout; at: number }>();

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
      for (const userId of [...this.online]) this.update(userId, HIDDEN_GRACE_MS);
    }, SWEEP_MS).unref();
  }

  isOnline(userId: string) {
    return this.online.has(userId);
  }

  lastSeenAt(userId: string): number | null {
    return this.online.has(userId) ? null : (this.lastSeen.get(userId) ?? null);
  }

  connectionCount(userId: string) {
    return this.byUser.get(userId)?.size ?? 0;
  }

  snapshot() {
    return { onlineIds: [...this.online], lastSeen: Object.fromEntries(this.lastSeen) };
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
    this.update(userId, CLOSE_GRACE_MS);
  }

  /** Connection closed / logged out. */
  detach(connId: string, graceMs = CLOSE_GRACE_MS) {
    const c = this.conns.get(connId);
    if (!c) return;
    this.conns.delete(connId);
    const set = this.byUser.get(c.userId);
    set?.delete(connId);
    if (set && set.size === 0) this.byUser.delete(c.userId);
    this.departed.set(c.userId, { at: Date.now(), token: c.token });
    this.update(c.userId, graceMs);
  }

  /** Client reported foreground/background (document.visibilityState). */
  setVisible(connId: string, visible: boolean) {
    const c = this.conns.get(connId);
    if (!c || c.visible === visible) return;
    c.visible = visible;
    if (!visible) this.departed.set(c.userId, { at: Date.now(), token: c.token });
    this.update(c.userId, HIDDEN_GRACE_MS);
  }

  /** Re-evaluate after something that affects activity (room join/leave). */
  refresh(userId: string) {
    this.update(userId, HIDDEN_GRACE_MS);
  }

  private active(userId: string) {
    for (const connId of this.byUser.get(userId) ?? []) {
      const c = this.conns.get(connId);
      if (c && (c.visible || this.inRoom(connId))) return true;
    }
    return false;
  }

  private update(userId: string, graceMs: number) {
    if (this.active(userId)) {
      const pending = this.timers.get(userId);
      if (pending) clearTimeout(pending.t);
      this.timers.delete(userId);
      this.departed.delete(userId);
      if (!this.online.has(userId)) {
        this.online.add(userId);
        this.broadcast({ userId, online: true, lastSeenAt: null });
      }
      return;
    }
    if (!this.online.has(userId)) return;
    const at = Date.now() + graceMs;
    const pending = this.timers.get(userId);
    if (pending && pending.at <= at) return; // an earlier offline is already scheduled
    if (pending) clearTimeout(pending.t);
    const t = setTimeout(() => {
      this.timers.delete(userId);
      if (!this.active(userId)) this.goOffline(userId);
    }, graceMs);
    t.unref();
    this.timers.set(userId, { t, at });
  }

  private goOffline(userId: string) {
    if (!this.online.delete(userId)) return;
    const d = this.departed.get(userId);
    this.departed.delete(userId);
    const at = d?.at ?? Date.now();
    this.lastSeen.set(userId, at);
    const token = d?.token ?? [...(this.byUser.get(userId) ?? [])].map((id) => this.conns.get(id)?.token).find(Boolean);
    if (token) this.persistLastSeen(token, at);
    this.broadcast({ userId, online: false, lastSeenAt: at });
  }

  private broadcast(u: PresenceUpdate) {
    this.io.to(PRESENCE_CHANNEL).emit("presence:update", u);
  }
}
