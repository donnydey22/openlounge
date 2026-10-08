// Message actions for 1:1 chats: "Delete for me" (per-viewer hidden ids) and the short-lived archive behind
// "Delete for everyone" (soft delete, migration 030_dm_deletes), plus edit stamps for 1:1 and group messages
// (031_dm_edits: edited_at / edit_count; the text itself is in dms). Write-through like chatPrefs: Postgres when
// DATABASE_URL is set, else DATA_DIR/dm-actions.json (local dev), memory-only in tests (DM_ACTIONS_MEMORY=1).
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { chooseSsl, withRetry } from "./pg";
import { DATA_DIR } from "./persistence";
import { log } from "./log";

export const ARCHIVE_DAYS = 30;

export interface ArchivedMessage {
  messageId: string;
  conversationId: string;
  fromId: string;
  toId: string;
  text: string;
  createdAt: number;
  deletedAt: number;
  deletedBy: string;
}

export class DmActions {
  private hidden = new Map<string, Map<string, number>>(); // userId -> messageId -> hiddenAt
  private archive = new Map<string, ArchivedMessage>();
  private edits = new Map<string, { at: number; count: number }>(); // messageId -> last edit
  private pool: pg.Pool | null = null;
  private chain: Promise<void> = Promise.resolve();
  private file: string | null = null;

  async load() {
    const url = process.env.DATABASE_URL;
    const cutoff = Date.now() - ARCHIVE_DAYS * 86_400_000;
    if (url) {
      const { ssl, connectionString } = chooseSsl(url);
      this.pool = new pg.Pool({ connectionString, ssl, max: 1, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, application_name: "openlounge-dmactions" });
      this.pool.on("error", (err) => log.warn("dm actions pg idle client error", { err }));
      try {
        await this.pool.query("DELETE FROM dm_deleted WHERE deleted_at < $1", [cutoff]);
        await this.pool.query("DELETE FROM dm_hidden h WHERE NOT EXISTS (SELECT 1 FROM dms WHERE dms.id = h.message_id)");
        const h = await this.pool.query<{ user_id: string; message_id: string; hidden_at: string }>("SELECT * FROM dm_hidden");
        for (const r of h.rows) this.setHidden(r.user_id, r.message_id, Number(r.hidden_at));
        const a = await this.pool.query<{ message_id: string; conversation_id: string; from_id: string; to_id: string; text: string; created_at: string; deleted_at: string; deleted_by: string }>(
          "SELECT * FROM dm_deleted",
        );
        await this.pool.query("DELETE FROM dm_edits e WHERE NOT EXISTS (SELECT 1 FROM dms WHERE dms.id = e.message_id)");
        const e = await this.pool.query<{ message_id: string; edited_at: string; edit_count: number }>("SELECT * FROM dm_edits");
        for (const r of e.rows) this.edits.set(r.message_id, { at: Number(r.edited_at), count: Number(r.edit_count) });
        for (const r of a.rows)
          this.archive.set(r.message_id, {
            messageId: r.message_id, conversationId: r.conversation_id, fromId: r.from_id, toId: r.to_id, text: r.text,
            createdAt: Number(r.created_at), deletedAt: Number(r.deleted_at), deletedBy: r.deleted_by,
          });
      } catch (err) {
        log.warn("dm actions load failed (hidden messages / delete archive start empty)", { err: String(err) });
      }
      return;
    }
    if (process.env.DM_ACTIONS_MEMORY === "1" || process.env.NODE_ENV === "test") return;
    this.file = path.join(DATA_DIR, "dm-actions.json");
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { hidden?: Record<string, Record<string, number>>; archive?: ArchivedMessage[]; edits?: Record<string, { at: number; count: number }> };
      for (const [u, ids] of Object.entries(raw.hidden ?? {})) for (const [id, at] of Object.entries(ids)) this.setHidden(u, id, at);
      for (const a of raw.archive ?? []) if (a.deletedAt >= cutoff) this.archive.set(a.messageId, a);
      for (const [id, e] of Object.entries(raw.edits ?? {})) this.edits.set(id, e);
    } catch {
      /* first run */
    }
  }

  /** ids this viewer deleted for themselves */
  hiddenFor(userId: string): ReadonlyMap<string, number> | undefined {
    return this.hidden.get(userId);
  }
  isHidden(userId: string, messageId: string) {
    return this.hidden.get(userId)?.has(messageId) ?? false;
  }

  hide(userId: string, messageIds: string[]) {
    const at = Date.now();
    const fresh = messageIds.filter((id) => !this.isHidden(userId, id));
    for (const id of fresh) this.setHidden(userId, id, at);
    if (!fresh.length) return;
    if (this.pool)
      this.q(
        "INSERT INTO dm_hidden (user_id, message_id, hidden_at) SELECT $1, m, $3 FROM unnest($2::text[]) AS m ON CONFLICT DO NOTHING",
        [userId, fresh, at],
      );
    else this.writeFile();
  }

  /** soft delete: keep a copy for moderation (reports) for ARCHIVE_DAYS */
  archiveMessages(rows: ArchivedMessage[]) {
    if (!rows.length) return;
    for (const r of rows) this.archive.set(r.messageId, r);
    for (const r of rows) for (const m of this.hidden.values()) m.delete(r.messageId); // gone for everyone anyway
    for (const r of rows) this.edits.delete(r.messageId);
    if (this.pool) {
      const c = <K extends keyof ArchivedMessage>(k: K) => rows.map((r) => r[k]);
      this.q(
        `INSERT INTO dm_deleted (message_id, conversation_id, from_id, to_id, text, created_at, deleted_at, deleted_by)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::bigint[], $8::text[])
         ON CONFLICT (message_id) DO NOTHING`,
        [c("messageId"), c("conversationId"), c("fromId"), c("toId"), c("text"), c("createdAt"), c("deletedAt"), c("deletedBy")],
      );
      this.q("DELETE FROM dm_hidden WHERE message_id = ANY($1::text[])", [rows.map((r) => r.messageId)]);
      this.q("DELETE FROM dm_edits WHERE message_id = ANY($1::text[])", [rows.map((r) => r.messageId)]);
    } else this.writeFile();
  }

  /** last edit of a message (null = never edited) */
  editOf(messageId: string) {
    return this.edits.get(messageId) ?? null;
  }
  /** all edit stamps (boot: copied onto the in-memory messages) */
  allEdits(): ReadonlyMap<string, { at: number; count: number }> {
    return this.edits;
  }
  /** a message was edited now: bump its stamp, returns the new one */
  markEdited(messageId: string, at = Date.now()) {
    const e = { at, count: (this.edits.get(messageId)?.count ?? 0) + 1 };
    this.edits.set(messageId, e);
    if (this.pool)
      this.q(
        `INSERT INTO dm_edits (message_id, edited_at, edit_count) VALUES ($1, $2, $3)
         ON CONFLICT (message_id) DO UPDATE SET edited_at = EXCLUDED.edited_at, edit_count = EXCLUDED.edit_count`,
        [messageId, e.at, e.count],
      );
    else this.writeFile();
    return e;
  }

  /** moderation: a message deleted for everyone (within ARCHIVE_DAYS) */
  archived(messageId: string) {
    return this.archive.get(messageId);
  }

  /** account deletion: the user's archived messages and their own hidden-ids go with them */
  forgetUser(userId: string) {
    let changed = this.hidden.delete(userId);
    for (const [id, a] of this.archive) if (a.fromId === userId) (this.archive.delete(id), (changed = true));
    if (!changed) return;
    if (this.pool) {
      this.q("DELETE FROM dm_hidden WHERE user_id = $1", [userId]);
      this.q("DELETE FROM dm_deleted WHERE from_id = $1", [userId]);
    } else this.writeFile();
  }

  drain() {
    return this.chain;
  }

  private setHidden(userId: string, messageId: string, at: number) {
    let m = this.hidden.get(userId);
    if (!m) this.hidden.set(userId, (m = new Map()));
    m.set(messageId, at);
  }

  private q(sql: string, params: unknown[]) {
    const pool = this.pool!;
    this.chain = this.chain.then(() =>
      withRetry(() => pool.query(sql, params).then(() => undefined), { attempts: 4, label: "dmactions" }).catch((err) => log.error("dm actions write failed", { err })),
    );
  }

  private writeFile() {
    if (!this.file) return;
    const hidden: Record<string, Record<string, number>> = {};
    for (const [u, m] of this.hidden) if (m.size) hidden[u] = Object.fromEntries(m);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ hidden, archive: [...this.archive.values()], edits: Object.fromEntries(this.edits) }));
    } catch (err) {
      log.warn("dm actions file write failed", { err: String(err) });
    }
  }
}
