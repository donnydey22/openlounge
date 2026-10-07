// Storage for device tokens, notification prefs and contact hashes. Postgres (DATABASE_URL) or in-memory.
import pg from "pg";
import { chooseSsl } from "../pg";
import { mergePrefs, type NotifPrefs } from "./prefs";

export type Platform = "android" | "ios" | "web";
export interface DeviceToken {
  token: string;
  userId: string;
  platform: Platform;
}

/** Unmatched contact hashes are deleted this long after upload (see docs/privacy-contacts.md). */
export const UNMATCHED_HASH_TTL_MS = 24 * 60 * 60_000;

export interface PushRepo {
  upsertToken(t: DeviceToken): Promise<void>;
  removeToken(token: string, userId?: string): Promise<void>;
  tokensFor(userId: string): Promise<DeviceToken[]>;
  getPrefs(userId: string): Promise<NotifPrefs>;
  setPrefs(userId: string, prefs: NotifPrefs): Promise<void>;
  /** replace the owner's stored (peppered) hashes */
  replaceContactHashes(ownerId: string, hashes: string[]): Promise<void>;
  deleteContactHashes(ownerId: string): Promise<void>;
  /** owners (who uploaded within the TTL) that have `hash` */
  ownersOfHash(hash: string): Promise<string[]>;
  purgeExpiredHashes(now?: number): Promise<number>;
  close(): Promise<void>;
}

export class MemoryPushRepo implements PushRepo {
  tokens = new Map<string, DeviceToken>();
  prefs = new Map<string, NotifPrefs>();
  hashes = new Map<string, { set: Set<string>; at: number }>();
  async upsertToken(t: DeviceToken) {
    this.tokens.set(t.token, { ...t });
  }
  async removeToken(token: string, userId?: string) {
    const t = this.tokens.get(token);
    if (t && (!userId || t.userId === userId)) this.tokens.delete(token);
  }
  async tokensFor(userId: string) {
    return [...this.tokens.values()].filter((t) => t.userId === userId);
  }
  async getPrefs(userId: string) {
    return mergePrefs(this.prefs.get(userId), null);
  }
  async setPrefs(userId: string, p: NotifPrefs) {
    this.prefs.set(userId, p);
  }
  async replaceContactHashes(ownerId: string, hashes: string[]) {
    this.hashes.set(ownerId, { set: new Set(hashes), at: Date.now() });
  }
  async deleteContactHashes(ownerId: string) {
    this.hashes.delete(ownerId);
  }
  async ownersOfHash(hash: string) {
    const now = Date.now();
    return [...this.hashes].filter(([, v]) => v.set.has(hash) && now - v.at < UNMATCHED_HASH_TTL_MS).map(([k]) => k);
  }
  async purgeExpiredHashes(now = Date.now()) {
    let n = 0;
    for (const [k, v] of this.hashes) if (now - v.at >= UNMATCHED_HASH_TTL_MS) (this.hashes.delete(k), n++);
    return n;
  }
  async close() {}
}

export class PgPushRepo implements PushRepo {
  private pool: pg.Pool;
  constructor(url: string) {
    const { connectionString, ssl } = chooseSsl(url);
    this.pool = new pg.Pool({ connectionString, ssl, max: 2, connectionTimeoutMillis: 10_000 });
    this.pool.on("error", (e) => console.warn("[push] pg idle error:", e.message));
  }
  async upsertToken(t: DeviceToken) {
    await this.pool.query(
      `INSERT INTO device_tokens (token, user_id, platform) VALUES ($1,$2,$3)
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, updated_at = now()`,
      [t.token, t.userId, t.platform],
    );
  }
  async removeToken(token: string, userId?: string) {
    if (userId) await this.pool.query("DELETE FROM device_tokens WHERE token = $1 AND user_id = $2", [token, userId]);
    else await this.pool.query("DELETE FROM device_tokens WHERE token = $1", [token]);
  }
  async tokensFor(userId: string) {
    const r = await this.pool.query<{ token: string; user_id: string; platform: Platform }>("SELECT token, user_id, platform FROM device_tokens WHERE user_id = $1", [userId]);
    return r.rows.map((x) => ({ token: x.token, userId: x.user_id, platform: x.platform }));
  }
  async getPrefs(userId: string) {
    const r = await this.pool.query<{ prefs: Partial<NotifPrefs> }>("SELECT prefs FROM notification_prefs WHERE user_id = $1", [userId]);
    return mergePrefs(r.rows[0]?.prefs, null);
  }
  async setPrefs(userId: string, p: NotifPrefs) {
    await this.pool.query(
      `INSERT INTO notification_prefs (user_id, prefs) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
      [userId, JSON.stringify(p)],
    );
  }
  async replaceContactHashes(ownerId: string, hashes: string[]) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("DELETE FROM contact_hashes WHERE owner_id = $1", [ownerId]);
      if (hashes.length) await c.query("INSERT INTO contact_hashes (owner_id, hash) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING", [ownerId, hashes]);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
  async deleteContactHashes(ownerId: string) {
    await this.pool.query("DELETE FROM contact_hashes WHERE owner_id = $1", [ownerId]);
  }
  async ownersOfHash(hash: string) {
    const r = await this.pool.query<{ owner_id: string }>(
      "SELECT owner_id FROM contact_hashes WHERE hash = $1 AND created_at > now() - ($2::bigint * interval '1 millisecond')",
      [hash, UNMATCHED_HASH_TTL_MS],
    );
    return r.rows.map((x) => x.owner_id);
  }
  async purgeExpiredHashes(now = Date.now()) {
    const r = await this.pool.query("DELETE FROM contact_hashes WHERE created_at <= to_timestamp($1::double precision / 1000)", [now - UNMATCHED_HASH_TTL_MS]);
    return r.rowCount ?? 0;
  }
  async close() {
    await this.pool.end().catch(() => {});
  }
}
