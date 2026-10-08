// Media metadata persistence: Postgres (DATABASE_URL, migration 026_media.sql) or memory (local dev without a DB).
import pg from "pg";
import { chooseSsl } from "../pg";
import type { MediaGoneReason, MediaKind, MediaStatus } from "../../src/lib/media/types";

export interface MediaFile {
  file: string;
  mime: string;
  size: number;
  /** HLS master entries: rungs available so far (short edge) and whether the ladder is complete */
  rungs?: number[];
  final?: boolean;
}

export interface MediaRow {
  id: string;
  ownerId: string;
  conversationId: string | null;
  messageId: string | null;
  kind: MediaKind;
  mime: string;
  name: string | null;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  waveform: string | null;
  placeholder: string | null;
  gif: boolean;
  files: Record<string, MediaFile>;
  status: MediaStatus;
  label: boolean;
  ttlSeconds: number | null;
  viewOnce: boolean;
  expiresAt: number | null;
  openedAt: number | null;
  playedAt: number | null;
  createdAt: number;
  sentAt: number | null;
  /** order inside an album (0 for single attachments) */
  position: number;
  /** URL version: bumped when a file is regenerated, so cached URLs never go stale (contract §2) */
  rev: number;
}

export interface Tombstone {
  messageId: string;
  mediaId: string;
  conversationId: string | null;
  kind: MediaKind;
  gif: boolean;
  viewOnce: boolean;
  reason: MediaGoneReason;
  at: number;
}

export interface MediaRepo {
  kind: "postgres" | "memory";
  insert(r: MediaRow): Promise<void>;
  update(id: string, patch: Partial<MediaRow>): Promise<void>;
  remove(id: string): Promise<void>;
  /** everything that's attached to a message (loaded once at boot) + unsent rows (for cleanup) */
  all(): Promise<MediaRow[]>;
  tombstone(t: Tombstone): Promise<void>;
  tombstones(): Promise<Tombstone[]>;
  close(): Promise<void>;
}

const COLS: [keyof MediaRow, string][] = [
  ["id", "id"],
  ["ownerId", "owner_id"],
  ["conversationId", "conversation_id"],
  ["messageId", "message_id"],
  ["kind", "kind"],
  ["mime", "mime"],
  ["name", "name"],
  ["size", "size_bytes"],
  ["width", "width"],
  ["height", "height"],
  ["durationMs", "duration_ms"],
  ["waveform", "waveform"],
  ["placeholder", "placeholder"],
  ["gif", "gif"],
  ["files", "files"],
  ["status", "status"],
  ["label", "label"],
  ["ttlSeconds", "ttl_seconds"],
  ["viewOnce", "view_once"],
  ["expiresAt", "expires_at"],
  ["openedAt", "opened_at"],
  ["playedAt", "played_at"],
  ["createdAt", "created_at"],
  ["sentAt", "sent_at"],
  ["position", "position"],
  ["rev", "rev"],
];
const colOf = new Map(COLS);
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function fromRow(r: Record<string, unknown>): MediaRow {
  return {
    id: String(r.id),
    ownerId: String(r.owner_id),
    conversationId: (r.conversation_id as string) ?? null,
    messageId: (r.message_id as string) ?? null,
    kind: r.kind as MediaKind,
    mime: String(r.mime),
    name: (r.name as string) ?? null,
    size: Number(r.size_bytes),
    width: n(r.width),
    height: n(r.height),
    durationMs: n(r.duration_ms),
    waveform: (r.waveform as string) ?? null,
    placeholder: (r.placeholder as string) ?? null,
    gif: !!r.gif,
    files: (r.files as Record<string, MediaFile>) ?? {},
    status: r.status as MediaStatus,
    label: !!r.label,
    ttlSeconds: n(r.ttl_seconds),
    viewOnce: !!r.view_once,
    expiresAt: n(r.expires_at),
    openedAt: n(r.opened_at),
    playedAt: n(r.played_at),
    createdAt: Number(r.created_at),
    sentAt: n(r.sent_at),
    position: Number(r.position ?? 0),
    rev: Number(r.rev ?? 1) || 1,
  };
}

export class PgMediaRepo implements MediaRepo {
  kind = "postgres" as const;
  private pool: pg.Pool;
  constructor(url: string) {
    const c = chooseSsl(url);
    this.pool = new pg.Pool({ connectionString: c.connectionString, ssl: c.ssl as pg.PoolConfig["ssl"], max: 3, idleTimeoutMillis: 30_000 });
    this.pool.on("error", () => {});
  }
  async insert(r: MediaRow) {
    const cols = COLS.map(([, c]) => c);
    const vals = COLS.map(([k]) => (k === "files" ? JSON.stringify(r.files) : r[k]));
    await this.pool.query(`INSERT INTO media (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT (id) DO NOTHING`, vals);
  }
  async update(id: string, patch: Partial<MediaRow>) {
    const keys = Object.keys(patch).filter((k) => k !== "id" && colOf.has(k as keyof MediaRow)) as (keyof MediaRow)[];
    if (!keys.length) return;
    const sets = keys.map((k, i) => `${colOf.get(k)} = $${i + 2}`);
    await this.pool.query(`UPDATE media SET ${sets.join(", ")} WHERE id = $1`, [id, ...keys.map((k) => (k === "files" ? JSON.stringify(patch[k]) : patch[k]))]);
  }
  async remove(id: string) {
    await this.pool.query("DELETE FROM media WHERE id = $1", [id]);
  }
  async all() {
    return (await this.pool.query("SELECT * FROM media")).rows.map(fromRow);
  }
  async tombstone(t: Tombstone) {
    await this.pool.query(
      `INSERT INTO media_tombstones (message_id, media_id, conversation_id, kind, gif, view_once, reason, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (message_id) DO NOTHING`,
      [t.messageId, t.mediaId, t.conversationId, t.kind, t.gif, t.viewOnce, t.reason, t.at],
    );
  }
  async tombstones() {
    return (await this.pool.query("SELECT * FROM media_tombstones")).rows.map(
      (r): Tombstone => ({ messageId: r.message_id, mediaId: r.media_id, conversationId: r.conversation_id, kind: r.kind, gif: !!r.gif, viewOnce: !!r.view_once, reason: r.reason, at: Number(r.at) }),
    );
  }
  async close() {
    await this.pool.end().catch(() => {});
  }
}

export class MemoryMediaRepo implements MediaRepo {
  kind = "memory" as const;
  rows = new Map<string, MediaRow>();
  tombs = new Map<string, Tombstone>();
  async insert(r: MediaRow) {
    if (!this.rows.has(r.id)) this.rows.set(r.id, structuredClone(r));
  }
  async update(id: string, patch: Partial<MediaRow>) {
    const r = this.rows.get(id);
    if (r) Object.assign(r, structuredClone(patch));
  }
  async remove(id: string) {
    this.rows.delete(id);
  }
  async all() {
    return [...this.rows.values()].map((r) => structuredClone(r));
  }
  async tombstone(t: Tombstone) {
    if (!this.tombs.has(t.messageId)) this.tombs.set(t.messageId, { ...t });
  }
  async tombstones() {
    return [...this.tombs.values()];
  }
  async close() {}
}
