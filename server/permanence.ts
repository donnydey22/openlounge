// Message permanence (034): every message that is not self-destructing stays forever, WhatsApp-style.
//  - DM / group "Delete for everyone" leaves a content-free placeholder (tombstone) in its place for every member.
//  - Live-room chat is stored (no cap) and survives the room ending and server restarts; paged like DMs.
// Write-through like dmActions: Postgres when DATABASE_URL is set, else DATA_DIR/permanence.json, memory-only in
// tests unless PERMANENCE_FILE points at a file (restart tests).
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { chooseSsl, withRetry } from "./pg";
import { DATA_DIR } from "./persistence";
import { log } from "./log";
import type { ChatMessage } from "../src/lib/types";

export const DELETED_TEXT = "This message was deleted";

export interface Tombstone {
  messageId: string;
  conversationId: string;
  fromId: string;
  fromName: string;
  fromColor: string;
  toId: string;
  createdAt: number;
  deletedAt: number;
}

export class Permanence {
  private tombs = new Map<string, Tombstone>();
  private rooms = new Map<string, ChatMessage[]>(); // roomId -> chat, oldest first
  private pool: pg.Pool | null = null;
  private chain: Promise<void> = Promise.resolve();
  private file: string | null = null;
  private fileTimer: NodeJS.Timeout | null = null;

  async load() {
    const url = process.env.DATABASE_URL;
    if (url) {
      const { ssl, connectionString } = chooseSsl(url);
      this.pool = new pg.Pool({ connectionString, ssl, max: 1, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, application_name: "openlounge-permanence" });
      this.pool.on("error", (err) => log.warn("permanence pg idle client error", { err }));
      try {
        const t = await this.pool.query("SELECT * FROM message_tombstones ORDER BY created_at, message_id");
        for (const r of t.rows)
          this.tombs.set(r.message_id, {
            messageId: r.message_id, conversationId: r.conversation_id, fromId: r.from_id, fromName: r.from_name, fromColor: r.from_color,
            toId: r.to_id, createdAt: Number(r.created_at), deletedAt: Number(r.deleted_at),
          });
        const m = await this.pool.query("SELECT data FROM room_messages ORDER BY room_id, created_at, id");
        for (const r of m.rows) this.pushRoom(r.data as ChatMessage);
      } catch (err) {
        log.error("permanence load failed (tombstones / room chat start empty this boot)", { err: String(err) });
      }
      return;
    }
    const f = process.env.PERMANENCE_FILE;
    if (!f && (process.env.PERMANENCE_MEMORY === "1" || process.env.NODE_ENV === "test")) return;
    this.file = f || path.join(DATA_DIR, "permanence.json");
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { tombstones?: Tombstone[]; rooms?: Record<string, ChatMessage[]> };
      for (const t of raw.tombstones ?? []) this.tombs.set(t.messageId, t);
      for (const list of Object.values(raw.rooms ?? {})) for (const m of list) this.pushRoom(m);
    } catch {
      /* first run */
    }
  }

  // ---------- DM / group placeholders ----------
  tombstones(): Iterable<Tombstone> {
    return this.tombs.values();
  }
  addTombstone(t: Tombstone) {
    if (this.tombs.has(t.messageId)) return;
    this.tombs.set(t.messageId, t);
    if (this.pool)
      this.q(
        `INSERT INTO message_tombstones (message_id, conversation_id, from_id, from_name, from_color, to_id, created_at, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (message_id) DO NOTHING`,
        [t.messageId, t.conversationId, t.fromId, t.fromName, t.fromColor, t.toId, t.createdAt, t.deletedAt],
      );
    else this.writeSoon();
  }

  // ---------- room chat ----------
  /** the room's full chat (live array: the store pushes into it through addRoomMessage) */
  roomChat(roomId: string): ChatMessage[] {
    let l = this.rooms.get(roomId);
    if (!l) this.rooms.set(roomId, (l = []));
    return l;
  }
  hasRoomChat(roomId: string) {
    return (this.rooms.get(roomId)?.length ?? 0) > 0;
  }
  addRoomMessage(m: ChatMessage) {
    const l = this.roomChat(m.roomId);
    if (!l.some((x) => x.id === m.id)) l.push(m);
    this.saveRoomMessage(m);
  }
  /** edit / delete-for-everyone: the message object was changed in place */
  saveRoomMessage(m: ChatMessage) {
    if (this.pool)
      this.q(
        `INSERT INTO room_messages (id, room_id, created_at, data, deleted_at) VALUES ($1,$2,$3,$4::jsonb,$5)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, deleted_at = COALESCE(room_messages.deleted_at, EXCLUDED.deleted_at)`,
        [m.id, m.roomId, m.createdAt, JSON.stringify(m), m.deleted ? (m.deletedAt ?? Date.now()) : null],
      );
    else this.writeSoon();
  }

  drain() {
    if (this.fileTimer) (clearTimeout(this.fileTimer), (this.fileTimer = null), this.writeFile());
    return this.chain;
  }

  private pushRoom(m: ChatMessage) {
    const l = this.roomChat(m.roomId);
    l.push(m);
  }
  private q(sql: string, params: unknown[]) {
    const pool = this.pool!;
    this.chain = this.chain.then(() =>
      withRetry(() => pool.query(sql, params).then(() => undefined), { attempts: 6, label: "permanence" }).catch((err) => log.error("permanence write failed", { err })),
    );
  }
  private writeSoon() {
    if (!this.file || this.fileTimer) return;
    this.fileTimer = setTimeout(() => ((this.fileTimer = null), this.writeFile()), 250);
    this.fileTimer.unref?.();
  }
  private writeFile() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ tombstones: [...this.tombs.values()], rooms: Object.fromEntries(this.rooms) }));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log.warn("permanence file write failed", { err: String(err) });
    }
  }
}
