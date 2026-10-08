// Durable storage for groups. Write-through: every change is queued and written in order right away (small volume),
// retried on transient errors. Postgres when DATABASE_URL is set, else DATA_DIR/groups.json (local dev).
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { chooseSsl, withRetry } from "../pg";
import { DATA_DIR } from "../persistence";
import { log } from "../log";
import type { ConvRecord, GroupsSnapshot, InviteRecord, MemberRecord, PinRecord, ServiceRecord } from "./types";

export interface GroupsRepo {
  load(): Promise<GroupsSnapshot>;
  upsertConv(c: ConvRecord): void;
  upsertMember(m: MemberRecord): void;
  deleteMember(conversationId: string, userId: string): void;
  setPin(p: PinRecord, on: boolean): void;
  upsertInvite(i: InviteRecord): void;
  addService(s: ServiceRecord): void;
  putPhoto(conversationId: string, mime: string, bytes: Buffer, version: number): void;
  getPhoto(conversationId: string): Promise<{ mime: string; bytes: Buffer; version: number } | null>;
  /** resolves once every queued write has been attempted */
  drain(): Promise<void>;
  close(): Promise<void>;
}

type Op = (c: pg.PoolClient | null) => Promise<void>;

export class PgGroupsRepo implements GroupsRepo {
  private pool: pg.Pool;
  private chain: Promise<void> = Promise.resolve();
  constructor(url: string) {
    const { ssl, connectionString } = chooseSsl(url);
    this.pool = new pg.Pool({ connectionString, ssl, max: 2, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, application_name: "openlounge-groups", keepAlive: true });
    this.pool.on("error", (err) => log.warn("groups pg idle client error", { err }));
  }
  private q(sql: string, params: unknown[]) {
    const run = () => this.pool.query(sql, params).then(() => undefined);
    this.chain = this.chain.then(() => withRetry(run, { attempts: 4, label: "groups" }).catch((err) => log.error("groups write failed", { err, sql: sql.slice(0, 60) })));
  }
  async load(): Promise<GroupsSnapshot> {
    const rows = async <T extends pg.QueryResultRow>(sql: string) => (await this.pool.query<T>(sql)).rows;
    const [convs, members, pins, invites, service] = await Promise.all([
      rows<Record<string, unknown>>("SELECT * FROM conversations WHERE type = 'group'"),
      rows<Record<string, unknown>>("SELECT m.* FROM conversation_members m JOIN conversations c ON c.id = m.conversation_id WHERE c.type = 'group'"),
      rows<Record<string, unknown>>("SELECT * FROM conversation_pins"),
      rows<Record<string, unknown>>("SELECT * FROM conversation_invites WHERE revoked_at IS NULL"),
      rows<Record<string, unknown>>("SELECT * FROM conversation_service"),
    ]);
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return {
      convs: convs.map((r) => ({
        id: String(r.id), type: r.type as "group", title: String(r.title), description: String(r.description), color: String(r.color),
        photoVersion: n(r.photo_version), createdBy: (r.created_by as string) ?? null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
        memberLimit: Number(r.member_limit), deletedAt: n(r.deleted_at),
      })),
      members: members.map((r) => ({
        conversationId: String(r.conversation_id), userId: String(r.user_id), role: r.role as MemberRecord["role"], joinedAt: Number(r.joined_at),
        muted: !!r.muted, lastReadAt: Number(r.last_read_at), addedBy: (r.added_by as string) ?? null,
      })),
      pins: pins.map((r) => ({ conversationId: String(r.conversation_id), messageId: String(r.message_id), pinnedBy: (r.pinned_by as string) ?? null, pinnedAt: Number(r.pinned_at) })),
      invites: invites.map((r) => ({
        token: String(r.token), conversationId: String(r.conversation_id), createdBy: (r.created_by as string) ?? null, createdAt: Number(r.created_at),
        expiresAt: n(r.expires_at), maxUses: n(r.max_uses), uses: Number(r.uses), revokedAt: n(r.revoked_at),
      })),
      service: service.map((r) => ({ messageId: String(r.message_id), conversationId: String(r.conversation_id), payload: r.payload as ServiceRecord["payload"] })),
    };
  }
  upsertConv(c: ConvRecord) {
    this.q(
      `INSERT INTO conversations (id, type, title, description, color, photo_version, created_by, created_at, updated_at, member_limit, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, color = EXCLUDED.color,
         photo_version = EXCLUDED.photo_version, updated_at = EXCLUDED.updated_at, member_limit = EXCLUDED.member_limit, deleted_at = EXCLUDED.deleted_at`,
      [c.id, c.type, c.title, c.description, c.color, c.photoVersion, c.createdBy, c.createdAt, c.updatedAt, c.memberLimit, c.deletedAt],
    );
  }
  upsertMember(m: MemberRecord) {
    this.q(
      `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, muted, last_read_at, added_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (conversation_id, user_id) DO UPDATE SET role = EXCLUDED.role, muted = EXCLUDED.muted,
         last_read_at = GREATEST(conversation_members.last_read_at, EXCLUDED.last_read_at)`,
      [m.conversationId, m.userId, m.role, m.joinedAt, m.muted, m.lastReadAt, m.addedBy],
    );
  }
  deleteMember(conversationId: string, userId: string) {
    this.q("DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2", [conversationId, userId]);
  }
  setPin(p: PinRecord, on: boolean) {
    if (on)
      this.q("INSERT INTO conversation_pins (conversation_id, message_id, pinned_by, pinned_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [p.conversationId, p.messageId, p.pinnedBy, p.pinnedAt]);
    else this.q("DELETE FROM conversation_pins WHERE conversation_id = $1 AND message_id = $2", [p.conversationId, p.messageId]);
  }
  upsertInvite(i: InviteRecord) {
    this.q(
      `INSERT INTO conversation_invites (token, conversation_id, created_by, created_at, expires_at, max_uses, uses, revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (token) DO UPDATE SET uses = EXCLUDED.uses, revoked_at = EXCLUDED.revoked_at`,
      [i.token, i.conversationId, i.createdBy, i.createdAt, i.expiresAt, i.maxUses, i.uses, i.revokedAt],
    );
  }
  addService(s: ServiceRecord) {
    this.q("INSERT INTO conversation_service (message_id, conversation_id, payload) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [s.messageId, s.conversationId, JSON.stringify(s.payload)]);
  }
  putPhoto(conversationId: string, mime: string, bytes: Buffer, version: number) {
    if (!bytes.length) this.q("DELETE FROM conversation_photos WHERE conversation_id = $1", [conversationId]);
    else
      this.q(
        "INSERT INTO conversation_photos (conversation_id, mime, bytes, version) VALUES ($1,$2,$3,$4) ON CONFLICT (conversation_id) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, version = EXCLUDED.version",
        [conversationId, mime, bytes, version],
      );
  }
  async getPhoto(conversationId: string) {
    await this.chain;
    const r = await this.pool.query<{ mime: string; bytes: Buffer; version: string }>("SELECT mime, bytes, version FROM conversation_photos WHERE conversation_id = $1", [conversationId]);
    const row = r.rows[0];
    return row ? { mime: row.mime, bytes: row.bytes, version: Number(row.version) } : null;
  }
  drain() {
    return this.chain;
  }
  async close() {
    await this.chain;
    await this.pool.end().catch(() => {});
  }
}

/** Local-dev fallback: the whole snapshot in DATA_DIR/groups.json (+ photos in memory and DATA_DIR/group-photos). */
export class JsonGroupsRepo implements GroupsRepo {
  private snap: GroupsSnapshot = { convs: [], members: [], pins: [], invites: [], service: [] };
  private timer: NodeJS.Timeout | null = null;
  private file = path.join(DATA_DIR, "groups.json");
  private photoDir = path.join(DATA_DIR, "group-photos");
  constructor(private persist = true) {}
  async load() {
    if (this.persist && fs.existsSync(this.file)) {
      try {
        this.snap = { ...this.snap, ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
      } catch (err) {
        log.warn("groups.json unreadable, starting empty", { err });
      }
    }
    return structuredClone(this.snap);
  }
  private save() {
    if (!this.persist || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.snap));
      fs.renameSync(this.file + ".tmp", this.file);
    }, 300);
    this.timer.unref?.();
  }
  private put<T>(list: T[], match: (x: T) => boolean, v: T | null) {
    const i = list.findIndex(match);
    if (v === null) {
      if (i >= 0) list.splice(i, 1);
    } else if (i >= 0) list[i] = v;
    else list.push(v);
    this.save();
  }
  upsertConv(c: ConvRecord) {
    this.put(this.snap.convs, (x) => x.id === c.id, { ...c });
  }
  upsertMember(m: MemberRecord) {
    this.put(this.snap.members, (x) => x.conversationId === m.conversationId && x.userId === m.userId, { ...m });
  }
  deleteMember(conversationId: string, userId: string) {
    this.put(this.snap.members, (x) => x.conversationId === conversationId && x.userId === userId, null);
  }
  setPin(p: PinRecord, on: boolean) {
    this.put(this.snap.pins, (x) => x.conversationId === p.conversationId && x.messageId === p.messageId, on ? { ...p } : null);
  }
  upsertInvite(i: InviteRecord) {
    this.put(this.snap.invites, (x) => x.token === i.token, { ...i });
  }
  addService(s: ServiceRecord) {
    this.put(this.snap.service, (x) => x.messageId === s.messageId, { ...s });
  }
  private photos = new Map<string, { mime: string; bytes: Buffer; version: number }>();
  putPhoto(conversationId: string, mime: string, bytes: Buffer, version: number) {
    if (!bytes.length) this.photos.delete(conversationId);
    else this.photos.set(conversationId, { mime, bytes, version });
    if (!this.persist) return;
    fs.mkdirSync(this.photoDir, { recursive: true });
    const f = path.join(this.photoDir, conversationId);
    if (!bytes.length) fs.rmSync(f, { force: true });
    else fs.writeFileSync(f, JSON.stringify({ mime, version, b64: bytes.toString("base64") }));
  }
  async getPhoto(conversationId: string) {
    const hit = this.photos.get(conversationId);
    if (hit || !this.persist) return hit ?? null;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.photoDir, conversationId), "utf8"));
      return { mime: j.mime, version: j.version, bytes: Buffer.from(j.b64, "base64") };
    } catch {
      return null;
    }
  }
  async drain() {}
  async close() {}
}

export function createGroupsRepo(): GroupsRepo {
  return process.env.DATABASE_URL ? new PgGroupsRepo(process.env.DATABASE_URL) : new JsonGroupsRepo();
}
export type { Op };
