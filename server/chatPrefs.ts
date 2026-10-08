// Per-user inbox state for 1:1 chats: pinned, and "Delete chat for me" (hidden up to a timestamp).
// Write-through like the groups repo: Postgres (dm_chat_state, migration 012_store_dm_chat_state) when DATABASE_URL
// is set, else DATA_DIR/dm-chat-state.json (local dev), memory-only in tests (CHAT_PREFS_MEMORY=1 or no DATA_DIR write).
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { chooseSsl, withRetry } from "./pg";
import { DATA_DIR } from "./persistence";
import { log } from "./log";

export interface ChatPref {
  pinnedAt: number | null;
  hiddenAt: number | null;
}

export class ChatPrefs {
  private map = new Map<string, Map<string, ChatPref>>(); // userId -> peerId -> pref
  private pool: pg.Pool | null = null;
  private chain: Promise<void> = Promise.resolve();
  private file: string | null = null;

  async load() {
    const url = process.env.DATABASE_URL;
    if (url) {
      const { ssl, connectionString } = chooseSsl(url);
      this.pool = new pg.Pool({ connectionString, ssl, max: 1, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, application_name: "openlounge-chatprefs" });
      this.pool.on("error", (err) => log.warn("chat prefs pg idle client error", { err }));
      try {
        const { rows } = await this.pool.query<{ user_id: string; peer_id: string; pinned_at: string | null; hidden_at: string | null }>("SELECT * FROM dm_chat_state");
        for (const r of rows) this.setLocal(r.user_id, r.peer_id, { pinnedAt: r.pinned_at === null ? null : Number(r.pinned_at), hiddenAt: r.hidden_at === null ? null : Number(r.hidden_at) });
      } catch (err) {
        log.warn("chat prefs load failed (inbox pins/hidden chats start empty)", { err: String(err) });
      }
      return;
    }
    if (process.env.CHAT_PREFS_MEMORY === "1") return;
    this.file = path.join(DATA_DIR, "dm-chat-state.json");
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, Record<string, ChatPref>>;
      for (const [u, peers] of Object.entries(raw)) for (const [p, v] of Object.entries(peers)) this.setLocal(u, p, v);
    } catch {
      /* first run */
    }
  }

  get(userId: string, peerId: string): ChatPref | undefined {
    return this.map.get(userId)?.get(peerId);
  }
  hiddenAt(userId: string, peerId: string) {
    return this.get(userId, peerId)?.hiddenAt ?? 0;
  }

  set(userId: string, peerId: string, patch: Partial<ChatPref>) {
    const cur = this.get(userId, peerId) ?? { pinnedAt: null, hiddenAt: null };
    const next = { ...cur, ...patch };
    this.setLocal(userId, peerId, next);
    this.persist(userId, peerId, next);
    return next;
  }

  /** account deletion: drop the deleted user's own prefs (other people's state about them stays theirs) */
  forgetUser(userId: string) {
    if (!this.map.delete(userId)) return;
    if (this.pool) this.q("DELETE FROM dm_chat_state WHERE user_id = $1", [userId]);
    else this.writeFile();
  }

  drain() {
    return this.chain;
  }

  private setLocal(userId: string, peerId: string, v: ChatPref) {
    let m = this.map.get(userId);
    if (!m) this.map.set(userId, (m = new Map()));
    if (!v.pinnedAt && !v.hiddenAt) m.delete(peerId);
    else m.set(peerId, { pinnedAt: v.pinnedAt ?? null, hiddenAt: v.hiddenAt ?? null });
  }

  private persist(userId: string, peerId: string, v: ChatPref) {
    if (this.pool)
      this.q(
        `INSERT INTO dm_chat_state (user_id, peer_id, pinned_at, hidden_at, updated_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, peer_id) DO UPDATE SET pinned_at = EXCLUDED.pinned_at, hidden_at = EXCLUDED.hidden_at, updated_at = EXCLUDED.updated_at`,
        [userId, peerId, v.pinnedAt, v.hiddenAt, Date.now()],
      );
    else this.writeFile();
  }

  private q(sql: string, params: unknown[]) {
    const pool = this.pool!;
    this.chain = this.chain.then(() =>
      withRetry(() => pool.query(sql, params).then(() => undefined), { attempts: 4, label: "chatprefs" }).catch((err) => log.error("chat prefs write failed", { err })),
    );
  }

  private writeFile() {
    if (!this.file) return;
    const out: Record<string, Record<string, ChatPref>> = {};
    for (const [u, m] of this.map) if (m.size) out[u] = Object.fromEntries(m);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(out));
    } catch (err) {
      log.warn("chat prefs file write failed", { err: String(err) });
    }
  }
}
