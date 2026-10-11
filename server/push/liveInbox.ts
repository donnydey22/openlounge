// "Live now" inbox: live-room notifications kept server-side so a missed banner isn't lost. One entry per
// (user, room); the newest notice for a room replaces the older one (and makes it unread again). Entries go
// away when the room ends. Also holds the weekly "Trending live" claims (server/push/trendingLive.ts).
// Postgres (DATABASE_URL, migration 032) or in-memory, like repo.ts.
import pg from "pg";
import { chooseSsl } from "../pg";

/** per user; older entries fall off */
export const LIVE_INBOX_MAX = 50;

export interface LiveNotice {
  roomId: string;
  type: string;
  actorId: string | null;
  title: string;
  body: string;
  url: string;
  at: number;
  readAt: number | null;
}

export interface LiveInboxRepo {
  /** upsert the user's entry for n.roomId (unread again); trims to LIVE_INBOX_MAX */
  add(userId: string, n: Omit<LiveNotice, "readAt">): Promise<void>;
  list(userId: string): Promise<LiveNotice[]>;
  /** roomIds omitted = everything; returns how many changed */
  markRead(userId: string, roomIds: string[] | null, at: number): Promise<number>;
  /** the room ended: drop its entries; returns the users who had one */
  clearRoom(roomId: string): Promise<string[]>;
  /** weekly pick idempotency: true when this call claimed (user, week) */
  claimWeek(userId: string, week: string, roomId: string): Promise<boolean>;
  /** the pick didn't go out (quiet hours, throttle, pref): give the week back so a later run can try */
  releaseWeek(userId: string, week: string): Promise<void>;
  deleteUserData(userId: string): Promise<void>;
  close(): Promise<void>;
}

export class MemoryLiveInbox implements LiveInboxRepo {
  rows = new Map<string, Map<string, LiveNotice>>();
  weeks = new Map<string, string>(); // `${userId}|${week}` -> roomId
  async add(userId: string, n: Omit<LiveNotice, "readAt">) {
    let m = this.rows.get(userId);
    if (!m) this.rows.set(userId, (m = new Map()));
    m.delete(n.roomId);
    m.set(n.roomId, { ...n, readAt: null });
    if (m.size > LIVE_INBOX_MAX) {
      const oldest = [...m.values()].sort((a, b) => a.at - b.at).slice(0, m.size - LIVE_INBOX_MAX);
      for (const o of oldest) m.delete(o.roomId);
    }
  }
  async list(userId: string) {
    return [...(this.rows.get(userId)?.values() ?? [])].sort((a, b) => b.at - a.at).map((x) => ({ ...x }));
  }
  async markRead(userId: string, roomIds: string[] | null, at: number) {
    let n = 0;
    for (const [rid, x] of this.rows.get(userId) ?? []) if (x.readAt === null && (!roomIds || roomIds.includes(rid))) (x.readAt = at, n++);
    return n;
  }
  async clearRoom(roomId: string) {
    const out: string[] = [];
    for (const [uid, m] of this.rows) if (m.delete(roomId)) out.push(uid);
    return out;
  }
  async claimWeek(userId: string, week: string, roomId: string) {
    const k = `${userId}|${week}`;
    if (this.weeks.has(k)) return false;
    this.weeks.set(k, roomId);
    return true;
  }
  async releaseWeek(userId: string, week: string) {
    this.weeks.delete(`${userId}|${week}`);
  }
  async deleteUserData(userId: string) {
    this.rows.delete(userId);
    for (const k of this.weeks.keys()) if (k.startsWith(`${userId}|`)) this.weeks.delete(k);
  }
  async close() {}
}

export class PgLiveInbox implements LiveInboxRepo {
  private pool: pg.Pool;
  constructor(url: string) {
    const { connectionString, ssl } = chooseSsl(url);
    this.pool = new pg.Pool({ connectionString, ssl, max: 2, connectionTimeoutMillis: 10_000 });
    this.pool.on("error", (e) => console.warn("[push] live inbox pg idle error:", e.message));
  }
  async add(userId: string, n: Omit<LiveNotice, "readAt">) {
    await this.pool.query(
      `INSERT INTO live_notices (user_id, room_id, type, actor_id, title, body, url, at, read_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL)
       ON CONFLICT (user_id, room_id) DO UPDATE SET type = EXCLUDED.type, actor_id = EXCLUDED.actor_id, title = EXCLUDED.title,
         body = EXCLUDED.body, url = EXCLUDED.url, at = EXCLUDED.at, read_at = NULL`,
      [userId, n.roomId, n.type, n.actorId, n.title, n.body, n.url, n.at],
    );
    await this.pool.query(
      `DELETE FROM live_notices WHERE user_id = $1 AND room_id IN (
         SELECT room_id FROM live_notices WHERE user_id = $1 ORDER BY at DESC OFFSET $2)`,
      [userId, LIVE_INBOX_MAX],
    );
  }
  async list(userId: string) {
    const r = await this.pool.query<{ room_id: string; type: string; actor_id: string | null; title: string; body: string; url: string; at: string; read_at: string | null }>(
      "SELECT room_id, type, actor_id, title, body, url, at, read_at FROM live_notices WHERE user_id = $1 ORDER BY at DESC LIMIT $2",
      [userId, LIVE_INBOX_MAX],
    );
    return r.rows.map((x) => ({ roomId: x.room_id, type: x.type, actorId: x.actor_id, title: x.title, body: x.body, url: x.url, at: Number(x.at), readAt: x.read_at === null ? null : Number(x.read_at) }));
  }
  async markRead(userId: string, roomIds: string[] | null, at: number) {
    const r = roomIds
      ? await this.pool.query("UPDATE live_notices SET read_at = $3 WHERE user_id = $1 AND read_at IS NULL AND room_id = ANY($2::text[])", [userId, roomIds, at])
      : await this.pool.query("UPDATE live_notices SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL", [userId, at]);
    return r.rowCount ?? 0;
  }
  async clearRoom(roomId: string) {
    const r = await this.pool.query<{ user_id: string }>("DELETE FROM live_notices WHERE room_id = $1 RETURNING user_id", [roomId]);
    return r.rows.map((x) => x.user_id);
  }
  async claimWeek(userId: string, week: string, roomId: string) {
    const r = await this.pool.query("INSERT INTO trending_live_sends (user_id, week, room_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [userId, week, roomId]);
    return (r.rowCount ?? 0) === 1;
  }
  async releaseWeek(userId: string, week: string) {
    await this.pool.query("DELETE FROM trending_live_sends WHERE user_id = $1 AND week = $2", [userId, week]);
  }
  async deleteUserData(userId: string) {
    await this.pool.query("DELETE FROM live_notices WHERE user_id = $1", [userId]);
    await this.pool.query("DELETE FROM trending_live_sends WHERE user_id = $1", [userId]);
  }
  async close() {
    await this.pool.end().catch(() => {});
  }
}
