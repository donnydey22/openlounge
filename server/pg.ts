// Postgres backend for the Store (used whenever DATABASE_URL is set, e.g. Railway Postgres).
//
// - Runs server/migrations/*.sql at boot (in order, once each, under an advisory lock; files are idempotent too).
// - load(): reads every table into the same PersistedDb shape db.json used.
// - save(snapshot): diffs against what was last written and upserts/deletes only changed rows,
//   all in one transaction. On failure nothing is marked as written, so the next save retries it.

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { conversationId } from "./conversation";
import { randomBytes } from "node:crypto";
import { log, metrics } from "./log";
import { errText, type IdentityProvider, type LoadResult, type OneTimeBackend, type EmailOtpBackend, type EmailOtpRow, type PersistedDb, type Persistence, type SessionRecord, type UserRecord } from "./persistence";

type SessionRow = {
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  id: string | null;
  scheme: number | null;
  legacy_hash: string | null;
  prev_hashes: string[] | null;
  rotated_at: number | null;
  access_expires_at: number | null;
  revoked_at: number | null;
  device: string | null;
  confirmed_at: number | null;
};

/** Rows written by an older server (e.g. the previous deploy still flushing) have NULL id / legacy_hash: treat them as legacy sessions. */
function sessionFromRow(s: SessionRow): SessionRecord {
  const scheme = s.scheme ?? 1;
  return {
    tokenHash: s.token_hash,
    userId: s.user_id,
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    lastSeenAt: s.last_seen_at,
    id: s.id ?? `s_${s.token_hash.slice(0, 32)}`,
    scheme,
    legacyHash: s.legacy_hash ?? (scheme === 1 ? s.token_hash : null),
    prevHashes: s.prev_hashes ?? [],
    rotatedAt: s.rotated_at,
    accessExpiresAt: s.access_expires_at,
    revokedAt: s.revoked_at,
    device: s.device ?? "",
    confirmedAt: s.confirmed_at ?? null,
  };
}

// BIGINT (int8) columns hold epoch-ms timestamps — safe as JS numbers.
pg.types.setTypeParser(20, (v) => Number(v));

const MIGRATION_LOCK = 72_727_001;
const CONNECT_ATTEMPTS = Number(process.env.DATABASE_CONNECT_ATTEMPTS || 15);
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

/** SQLSTATEs / socket errors worth retrying: connection loss, admin shutdown (failover/redeploy), serialization/deadlock. */
const TRANSIENT = new Set(["57P01", "57P02", "57P03", "08000", "08003", "08006", "08001", "08004", "40001", "40P01", "53300", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"]);
export function isTransientPgError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code && TRANSIENT.has(e.code)) return true;
  return /Connection terminated|connection timeout|timeout exceeded when trying to connect/i.test(e.message ?? "");
}

/** Run fn, retrying transient failures with jittered exponential backoff (default 3 attempts). */
export async function withRetry<T>(fn: () => Promise<T>, opts: { attempts?: number; baseMs?: number; label?: string } = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientPgError(err) || i === attempts - 1) throw err;
      metrics.inc("pg_retries_total");
      const delay = (opts.baseMs ?? 100) * 2 ** i * (0.5 + Math.random());
      log.warn("pg transient error, retrying", { label: opts.label, attempt: i + 1, delayMs: Math.round(delay), code: (err as { code?: string }).code });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Postgres TEXT can't hold NUL bytes; strip them so one odd message can't wedge every future save. */
const t = (s: unknown) => String(s ?? "").replace(/\u0000/g, "");
const tn = (s: unknown) => (s === undefined || s === null ? null : t(s));

type Rows = Record<"users" | "follows" | "rooms" | "dms" | "sessions" | "dmReads" | "identities", Map<string, unknown[]>>;
type Snapshot = Record<keyof Rows, Map<string, string>>;
const TABLES: (keyof Rows)[] = ["users", "follows", "rooms", "dms", "sessions", "dmReads", "identities"];
const SEP = "\u0001";

function migrationsDir() {
  const candidates = [
    typeof __dirname !== "undefined" ? path.join(__dirname, "migrations") : "",
    path.join(process.cwd(), "server", "migrations"),
  ].filter(Boolean);
  const dir = candidates.find((d) => fs.existsSync(d));
  if (!dir) throw new Error(`[pg] migrations folder not found (looked in ${candidates.join(", ")})`);
  return dir;
}

type SslChoice = { ssl: pg.PoolConfig["ssl"] | undefined; label: string };

/**
 * TLS for the Postgres connection.
 *   DATABASE_SSL=disable|require|verify  → explicit override.
 *   ?sslmode= in the URL                 → libpq meaning (require/prefer = encrypt without CA check, verify-* = verify).
 *   *.railway.internal                   → no TLS (Railway private network; this is what ${{Postgres.DATABASE_URL}} gives you).
 *   *.rlwy.net / *.railway.app           → TLS without CA check (Railway's public TCP proxy uses a self-signed cert).
 *   anything else (localhost …)          → no TLS, like plain node-postgres.
 * The sslmode param is always stripped from the URL so it can't override this (node-postgres would treat
 * sslmode=require as verify-full and reject Railway's self-signed cert).
 */
export function chooseSsl(url: string): SslChoice & { connectionString: string } {
  let host = "";
  let sslmode = "";
  let connectionString = url;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    sslmode = (u.searchParams.get("sslmode") || "").toLowerCase();
    u.searchParams.delete("sslmode");
    u.searchParams.delete("uselibpqcompat");
    connectionString = u.toString();
  } catch {
    /* keep as-is */
  }
  const noVerify = { rejectUnauthorized: false };
  const pick = (mode: string, why: string): SslChoice | null => {
    if (["disable", "off", "false", "0", "allow"].includes(mode)) return { ssl: false, label: `off (${why})` };
    if (["require", "prefer", "true", "1", "no-verify", "on"].includes(mode)) return { ssl: noVerify, label: `on, no CA check (${why})` };
    if (["verify", "verify-ca", "verify-full"].includes(mode)) return { ssl: { rejectUnauthorized: true }, label: `on, verified (${why})` };
    return null;
  };
  const choice =
    pick((process.env.DATABASE_SSL || "").toLowerCase(), "DATABASE_SSL") ??
    pick(sslmode, `sslmode=${sslmode}`) ??
    (host.endsWith(".railway.internal")
      ? { ssl: false, label: "off (Railway private network)" }
      : host.endsWith(".rlwy.net") || host.endsWith(".railway.app")
        ? { ssl: noVerify, label: "on, no CA check (Railway public proxy)" }
        : { ssl: undefined, label: "off (default)" });
  return { ...choice, connectionString };
}

export function redactUrl(url: string) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "postgres";
  }
}

export class PgPersistence implements Persistence {
  kind = "postgres" as const;
  where: string;
  sslLabel: string;
  /** whether the live connection is actually TLS (from pg_stat_ssl), null if unknown */
  tlsActive: boolean | null = null;
  private pool: pg.Pool;
  private written: Snapshot = { users: new Map(), follows: new Map(), rooms: new Map(), dms: new Map(), sessions: new Map(), dmReads: new Map(), identities: new Map() };

  constructor(url: string) {
    this.where = redactUrl(url);
    const { ssl, label, connectionString } = chooseSsl(url);
    this.sslLabel = label;
    this.pool = new pg.Pool({
      connectionString,
      ssl,
      max: num(process.env.DATABASE_POOL_MAX, 5),
      idleTimeoutMillis: num(process.env.DATABASE_IDLE_TIMEOUT_MS, 30_000),
      connectionTimeoutMillis: num(process.env.DATABASE_CONNECT_TIMEOUT_MS, 10_000),
      // server-side guards: no query/transaction may hold a connection forever
      statement_timeout: num(process.env.DATABASE_STATEMENT_TIMEOUT_MS, 15_000),
      idle_in_transaction_session_timeout: num(process.env.DATABASE_IDLE_TX_TIMEOUT_MS, 30_000),
      query_timeout: num(process.env.DATABASE_QUERY_TIMEOUT_MS, 20_000),
      application_name: "openlounge",
      keepAlive: true,
    });
    this.pool.on("error", (err) => log.warn("pg idle client error", { err }));
    metrics.gauge("pg_pool_total", () => this.pool.totalCount);
    metrics.gauge("pg_pool_idle", () => this.pool.idleCount);
    metrics.gauge("pg_pool_waiting", () => this.pool.waitingCount);
  }

  /** Connect (retrying while the database boots) and apply pending migrations. Throws a clear error on failure. */
  async connectAndMigrate() {
    let lastErr: unknown;
    for (let i = 1; i <= CONNECT_ATTEMPTS; i++) {
      try {
        await this.pool.query("SELECT 1");
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`[pg] cannot reach ${this.where} (attempt ${i}/${CONNECT_ATTEMPTS}): ${errText(err)}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!lastErr) {
      const r = await this.pool.query<{ ssl: boolean }>("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()").catch(() => null);
      this.tlsActive = r?.rows[0]?.ssl ?? null;
    }
    if (lastErr) throw new Error(`[pg] could not connect to Postgres at ${this.where}: ${errText(lastErr)}. Check DATABASE_URL (Railway: reference the Postgres service's DATABASE_URL).`);

    const client = await this.pool.connect();
    try {
      // migrations (index builds) may legitimately exceed the per-statement guard
      await client.query("SET statement_timeout = 0");
      // session-level advisory lock: a second instance booting concurrently waits here, then sees the versions applied
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
      await client.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
      );
      const done = new Set((await client.query<{ version: string }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
      const dir = migrationsDir();
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
      for (const file of files) {
        if (done.has(file)) continue;
        const sql = fs.readFileSync(path.join(dir, file), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING", [file]);
          await client.query("COMMIT");
          console.log(`[pg] applied migration ${file}`);
        } catch (err) {
          await client.query("ROLLBACK");
          throw new Error(`[pg] migration ${file} failed: ${errText(err)}`);
        }
      }
      console.log(`[pg] schema up to date: ${files.length} migrations applied (latest ${files.at(-1) ?? "none"})`);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
      await client.query("RESET statement_timeout").catch(() => {});
      client.release();
    }
  }

  // ---------- read ----------

  async load(): Promise<LoadResult> {
    const q = <R extends pg.QueryResultRow>(sql: string, params?: unknown[]) => this.pool.query<R>(sql, params).then((r) => r.rows);
    // expired sessions would have been dropped from db.json on the next write; drop them here
    await q("DELETE FROM sessions WHERE expires_at <= $1", [Date.now()]);
    const [users, interests, follows, rooms, dms, sessions, reads, meta, identities] = await Promise.all([
      q<{ id: string; name: string; username: string; color: string; bio: string; phone: string | null; created_at: number; base_followers: number; base_following: number; photo_version: number | null; password_hash: string | null; social_links: Record<string, string> | null }>(
        "SELECT * FROM users ORDER BY created_at, id",
      ),
      q<{ user_id: string; interest: string }>("SELECT user_id, interest FROM user_interests ORDER BY user_id, position"),
      q<{ follower_id: string; followee_id: string }>("SELECT follower_id, followee_id FROM follows ORDER BY created_at, follower_id, followee_id"),
      q<{ id: string; title: string; topic: string; description: string; host_id: string; created_at: number }>("SELECT * FROM rooms ORDER BY created_at, id"),
      q<{ id: string; from_id: string; from_name: string; from_color: string; to_id: string; text: string; created_at: number; read_at: number | null; client_id: string | null }>(
        "SELECT id, from_id, from_name, from_color, to_id, text, created_at, read_at, client_id FROM dms ORDER BY created_at, id",
      ),
      q<SessionRow>("SELECT * FROM sessions"),
      q<{ user_id: string; peer_id: string; last_read_at: number }>("SELECT * FROM dm_reads"),
      q<{ value: string }>("SELECT value FROM openlounge_meta WHERE key = 'json_imported'"),
      q<{ user_id: string; provider: IdentityProvider; provider_subject: string; email: string | null; verified: boolean; created_at: number; last_used_at: number | null }>(
        "SELECT * FROM auth_identities ORDER BY created_at, provider, provider_subject",
      ),
    ]);

    const interestsOf = new Map<string, string[]>();
    for (const r of interests) (interestsOf.get(r.user_id) ?? interestsOf.set(r.user_id, []).get(r.user_id)!).push(r.interest);
    const db: PersistedDb = {
      version: 1,
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        username: u.username,
        color: u.color,
        bio: u.bio,
        isBot: false,
        createdAt: u.created_at,
        baseFollowers: u.base_followers,
        baseFollowing: u.base_following,
        ...(u.phone !== null ? { phone: u.phone } : {}),
        interests: interestsOf.get(u.id) ?? [],
        photoVersion: u.photo_version,
        socialLinks: u.social_links ?? {},
        passwordHash: u.password_hash ?? null,
      })),
      follows: {},
      rooms: rooms.map((r) => ({ id: r.id, title: r.title, topic: r.topic, description: r.description, hostId: r.host_id, createdAt: r.created_at })),
      dms: dms.map((m) => ({ id: m.id, fromId: m.from_id, fromName: m.from_name, fromColor: m.from_color, toId: m.to_id, text: m.text, createdAt: m.created_at, readAt: m.read_at ?? null, ...(m.client_id ? { clientId: m.client_id } : {}) })),
      sessions: sessions.map(sessionFromRow),
      dmReads: {},
      identities: identities.map((i) => ({
        userId: i.user_id,
        provider: i.provider,
        subject: i.provider_subject,
        email: i.email,
        verified: i.verified,
        createdAt: i.created_at,
        lastUsedAt: i.last_used_at,
      })),
    };
    for (const f of follows) (db.follows[f.follower_id] ??= []).push(f.followee_id);
    for (const r of reads) (db.dmReads![r.user_id] ??= {})[r.peer_id] = r.last_read_at;

    this.written = this.serialize(this.rows(db));
    return { db, empty: users.length === 0 && meta.length === 0 };
  }

  // ---------- write ----------

  /** PersistedDb → table rows keyed by primary key. Rows owned by an unknown user are skipped (FK safety). */
  private rows(db: PersistedDb): Rows {
    const out: Rows = { users: new Map(), follows: new Map(), rooms: new Map(), dms: new Map(), sessions: new Map(), dmReads: new Map(), identities: new Map() };
    const humans = new Set<string>();
    for (const u of db.users ?? []) {
      humans.add(u.id);
      out.users.set(u.id, [
        u.id,
        t(u.name),
        t(u.username),
        t(u.color),
        t(u.bio),
        tn(u.phone),
        u.createdAt,
        Math.round(u.baseFollowers ?? 0),
        Math.round(u.baseFollowing ?? 0),
        u.photoVersion ?? null,
        (u.interests ?? []).map(t),
        JSON.stringify(u.socialLinks ?? {}),
        u.passwordHash ?? null,
      ]);
    }
    for (const [follower, list] of Object.entries(db.follows ?? {})) {
      if (!humans.has(follower)) continue;
      for (const followee of new Set(list)) out.follows.set(`${follower}${SEP}${followee}`, [follower, t(followee)]);
    }
    for (const r of db.rooms ?? []) out.rooms.set(r.id, [r.id, t(r.title), t(r.topic), t(r.description), t(r.hostId), r.createdAt]);
    for (const m of db.dms ?? [])
      out.dms.set(m.id, [m.id, conversationId(m.fromId, m.toId), t(m.fromId), t(m.fromName), t(m.fromColor), t(m.toId), t(m.text), m.createdAt, m.readAt ?? null, tn(m.clientId)]);
    for (const s of db.sessions ?? [])
      if (humans.has(s.userId))
        out.sessions.set(s.tokenHash, [
          s.tokenHash,
          s.userId,
          s.createdAt,
          s.expiresAt,
          s.lastSeenAt,
          s.id ?? `s_${s.tokenHash.slice(0, 32)}`,
          s.scheme ?? 1,
          s.legacyHash ?? null,
          `{${(s.prevHashes ?? []).filter((h) => /^[0-9a-f]{64}$/.test(h)).join(",")}}`,
          s.rotatedAt ?? null,
          s.accessExpiresAt ?? null,
          s.revokedAt ?? null,
          t(s.device ?? ""),
          s.confirmedAt ?? null,
        ]);
    for (const [uid, peers] of Object.entries(db.dmReads ?? {})) {
      if (!humans.has(uid)) continue;
      for (const [peer, ts] of Object.entries(peers)) out.dmReads.set(`${uid}${SEP}${peer}`, [uid, t(peer), ts]);
    }
    for (const i of db.identities ?? [])
      if (humans.has(i.userId))
        out.identities.set(`${i.provider}${SEP}${i.subject}`, [i.userId, i.provider, t(i.subject), tn(i.email), !!i.verified, i.createdAt, i.lastUsedAt ?? null]);
    return out;
  }

  private serialize(rows: Rows): Snapshot {
    const s = {} as Snapshot;
    for (const k of TABLES) s[k] = new Map([...rows[k]].map(([key, v]) => [key, JSON.stringify(v)]));
    return s;
  }

  /** Snapshot save: one transaction, retried on transient errors (connection drop, failover, serialization). */
  async save(db: PersistedDb) {
    return withRetry(() => this.saveOnce(db), { label: "save" });
  }

  private async saveOnce(db: PersistedDb) {
    const rows = this.rows(db);
    const next = this.serialize(rows);
    const up = {} as Record<keyof Rows, unknown[][]>;
    const del = {} as Record<keyof Rows, string[]>;
    let changes = 0;
    for (const k of TABLES) {
      up[k] = [...next[k]].filter(([key, v]) => this.written[k].get(key) !== v).map(([key]) => rows[k].get(key)!);
      del[k] = [...this.written[k].keys()].filter((key) => !next[k].has(key));
      changes += up[k].length + del[k].length;
    }
    if (!changes) return;

    const col = (list: unknown[][], i: number) => list.map((r) => r[i]);
    const pairs = (keys: string[]) => [keys.map((k) => k.split(SEP)[0]), keys.map((k) => k.split(SEP)[1])];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // users (+ their ordered interests)
      if (up.users.length) {
        const u = up.users;
        await client.query(
          `INSERT INTO users (id, name, username, color, bio, phone, created_at, base_followers, base_following, photo_version, social_links, password_hash)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::bigint[], $8::int[], $9::int[], $10::bigint[], $11::jsonb[], $12::text[])
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, username = EXCLUDED.username, color = EXCLUDED.color, bio = EXCLUDED.bio,
             phone = EXCLUDED.phone, created_at = EXCLUDED.created_at, base_followers = EXCLUDED.base_followers,
             base_following = EXCLUDED.base_following, photo_version = EXCLUDED.photo_version, social_links = EXCLUDED.social_links, password_hash = EXCLUDED.password_hash`,
          [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12].map((i) => col(u, i)),
        );
        const ids = col(u, 0) as string[];
        await client.query("DELETE FROM user_interests WHERE user_id = ANY($1::text[])", [ids]);
        const iu: string[] = [], ip: number[] = [], iv: string[] = [];
        for (const r of u) (r[10] as string[]).forEach((interest, pos) => (iu.push(r[0] as string), ip.push(pos), iv.push(interest)));
        if (iu.length)
          await client.query("INSERT INTO user_interests (user_id, position, interest) SELECT * FROM unnest($1::text[], $2::smallint[], $3::text[])", [iu, ip, iv]);
      }
      // follows
      if (del.follows.length)
        await client.query(
          "DELETE FROM follows f USING unnest($1::text[], $2::text[]) AS d(a, b) WHERE f.follower_id = d.a AND f.followee_id = d.b",
          pairs(del.follows),
        );
      if (up.follows.length)
        await client.query("INSERT INTO follows (follower_id, followee_id) SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT DO NOTHING", [
          col(up.follows, 0),
          col(up.follows, 1),
        ]);
      // rooms (only open, user-created rooms are in the snapshot; ended rooms disappear → deleted)
      if (del.rooms.length) await client.query("DELETE FROM rooms WHERE id = ANY($1::text[])", [del.rooms]);
      if (up.rooms.length)
        await client.query(
          `INSERT INTO rooms (id, title, topic, description, host_id, created_at)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[])
           ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, topic = EXCLUDED.topic, description = EXCLUDED.description,
             host_id = EXCLUDED.host_id, created_at = EXCLUDED.created_at`,
          [0, 1, 2, 3, 4, 5].map((i) => col(up.rooms, i)),
        );
      // DMs (text immutable; read_at set once when seen; per-conversation cap trims show up as deletes)
      if (del.dms.length) await client.query("DELETE FROM dms WHERE id = ANY($1::text[])", [del.dms]);
      if (up.dms.length)
        await client.query(
          `INSERT INTO dms (id, conversation_id, from_id, from_name, from_color, to_id, text, created_at, read_at, client_id)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::bigint[], $9::bigint[], $10::text[])
           ON CONFLICT (id) DO UPDATE SET text = EXCLUDED.text, from_name = EXCLUDED.from_name, from_color = EXCLUDED.from_color,
             read_at = COALESCE(dms.read_at, EXCLUDED.read_at), client_id = COALESCE(dms.client_id, EXCLUDED.client_id)`,
          [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => col(up.dms, i)),
        );
      // sessions
      if (del.sessions.length) await client.query("DELETE FROM sessions WHERE token_hash = ANY($1::text[])", [del.sessions]);
      if (up.sessions.length)
        // prev_hashes travels as a Postgres array literal (unnest can't take a 2-D text[][] of ragged arrays)
        await client.query(
          `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, id, scheme, legacy_hash, prev_hashes, rotated_at, access_expires_at, revoked_at, device, confirmed_at)
           SELECT a, b, c, d, e, f, g, h, i::text[], j, k, l, m, n FROM unnest($1::text[], $2::text[], $3::bigint[], $4::bigint[], $5::bigint[], $6::text[], $7::smallint[],
             $8::text[], $9::text[], $10::bigint[], $11::bigint[], $12::bigint[], $13::text[], $14::bigint[]) AS x(a, b, c, d, e, f, g, h, i, j, k, l, m, n)
           ON CONFLICT (token_hash) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at, last_seen_at = EXCLUDED.last_seen_at,
             id = EXCLUDED.id, scheme = EXCLUDED.scheme, legacy_hash = EXCLUDED.legacy_hash, prev_hashes = EXCLUDED.prev_hashes,
             rotated_at = EXCLUDED.rotated_at, access_expires_at = EXCLUDED.access_expires_at, revoked_at = EXCLUDED.revoked_at, device = EXCLUDED.device,
             confirmed_at = EXCLUDED.confirmed_at`,
          [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((i) => col(up.sessions, i)),
        );
      // DM read cursors
      if (del.dmReads.length)
        await client.query("DELETE FROM dm_reads r USING unnest($1::text[], $2::text[]) AS d(a, b) WHERE r.user_id = d.a AND r.peer_id = d.b", pairs(del.dmReads));
      if (up.dmReads.length)
        await client.query(
          `INSERT INTO dm_reads (user_id, peer_id, last_read_at) SELECT * FROM unnest($1::text[], $2::text[], $3::bigint[])
           ON CONFLICT (user_id, peer_id) DO UPDATE SET last_read_at = EXCLUDED.last_read_at`,
          [0, 1, 2].map((i) => col(up.dmReads, i)),
        );
      // sign-in identities (after users: FK). Deletes = unlinked methods.
      if (del.identities.length)
        await client.query(
          "DELETE FROM auth_identities a USING unnest($1::text[], $2::text[]) AS d(p, s) WHERE a.provider = d.p AND a.provider_subject = d.s",
          pairs(del.identities),
        );
      if (up.identities.length)
        await client.query(
          `INSERT INTO auth_identities (user_id, provider, provider_subject, email, verified, created_at, last_used_at)
           SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::boolean[], $6::bigint[], $7::bigint[])
           ON CONFLICT (provider, provider_subject) DO UPDATE SET user_id = EXCLUDED.user_id, email = EXCLUDED.email, verified = EXCLUDED.verified,
             last_used_at = EXCLUDED.last_used_at`,
          [0, 1, 2, 3, 4, 5, 6].map((i) => col(up.identities, i)),
        );
      // users removed last (cascades). The app never deletes accounts today; kept for completeness.
      if (del.users.length) await client.query("DELETE FROM users WHERE id = ANY($1::text[])", [del.users]);
      await client.query("COMMIT");
      this.written = next;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** single-use secrets: password reset links + other one-time codes (see Persistence.oneTime) */
  oneTime: OneTimeBackend = {
    put: async (table, r) => {
      // opportunistic cleanup of long-dead rows
      if (Math.random() < 0.05) {
        const old = Date.now() - 7 * 86_400_000;
        await this.pool.query("DELETE FROM password_reset_tokens WHERE expires_at < $1", [old]).catch(() => {});
        await this.pool.query("DELETE FROM auth_one_time_codes WHERE expires_at < $1", [old]).catch(() => {});
      }
      if (table === "reset")
        await this.pool.query(
          "INSERT INTO password_reset_tokens (token_hash, user_id, email, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)",
          [r.hash, r.userId, r.email, r.createdAt, r.expiresAt],
        );
      else
        await this.pool.query("INSERT INTO auth_one_time_codes (code_hash, purpose, payload, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)", [
          r.hash,
          r.purpose,
          JSON.stringify(r.payload ?? {}),
          r.createdAt,
          r.expiresAt,
        ]);
    },
    consume: async (table, hash, purpose, now) => {
      if (table === "reset") {
        const r = await this.pool.query<{ user_id: string; email: string }>(
          "UPDATE password_reset_tokens SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING user_id, email",
          [hash, now],
        );
        return r.rows[0] ? { userId: r.rows[0].user_id, email: r.rows[0].email } : null;
      }
      const r = await this.pool.query<{ payload: unknown }>(
        "UPDATE auth_one_time_codes SET used_at = $3 WHERE code_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3 RETURNING payload",
        [hash, purpose, now],
      );
      return r.rows[0] ? { payload: r.rows[0].payload } : null;
    },
    peekReset: async (hash, now) => {
      const r = await this.pool.query<{ user_id: string; email: string }>(
        "SELECT user_id, email FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2",
        [hash, now],
      );
      return r.rows[0] ? { userId: r.rows[0].user_id, email: r.rows[0].email } : null;
    },
    supersedeResets: async (userId, now) => {
      await this.pool.query("UPDATE password_reset_tokens SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL", [userId, now]);
    },
  };

  /** hashed 6-digit email codes (migration 010) */
  emailOtp: EmailOtpBackend = {
    get: async (key) => {
      const r = await this.pool.query<OtpDbRow>("SELECT * FROM email_otp_codes WHERE otp_key = $1", [key]);
      return r.rows[0] ? otpRow(r.rows[0]) : null;
    },
    put: async (r) => {
      if (Math.random() < 0.05) await this.pool.query("DELETE FROM email_otp_codes WHERE expires_at < $1", [Date.now() - 86_400_000]).catch(() => {});
      await this.pool.query(
        `INSERT INTO email_otp_codes (otp_key, email, purpose, user_id, code_hash, attempts, created_at, expires_at, used_at)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7, NULL)
         ON CONFLICT (otp_key) DO UPDATE SET email = EXCLUDED.email, purpose = EXCLUDED.purpose, user_id = EXCLUDED.user_id,
           code_hash = EXCLUDED.code_hash, attempts = 0, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at, used_at = NULL`,
        [r.key, r.email, r.purpose, r.userId, r.codeHash, r.createdAt, r.expiresAt],
      );
    },
    attempt: async (key, max, now) => {
      const r = await this.pool.query<OtpDbRow>(
        "UPDATE email_otp_codes SET attempts = attempts + 1 WHERE otp_key = $1 AND used_at IS NULL AND expires_at > $2 AND attempts < $3 RETURNING *",
        [key, now, max],
      );
      return r.rows[0] ? otpRow(r.rows[0]) : null;
    },
    markUsed: async (key, codeHash, now) => {
      const r = await this.pool.query("UPDATE email_otp_codes SET used_at = $3 WHERE otp_key = $1 AND code_hash = $2 AND used_at IS NULL", [key, codeHash, now]);
      return (r.rowCount ?? 0) > 0;
    },
  };

  /** The key persisted in the DB (created on first boot). Returned even when AUTH_SECRET is set: it stays a verification key. */
  async authSecret() {
    const fresh = randomBytes(32).toString("hex");
    await this.pool.query("INSERT INTO openlounge_meta (key, value) VALUES ('auth_secret', $1) ON CONFLICT (key) DO NOTHING", [fresh]);
    const r = await this.pool.query<{ value: string }>("SELECT value FROM openlounge_meta WHERE key = 'auth_secret'");
    return r.rows[0]?.value ?? fresh;
  }

  /** Session (and its user) straight from Postgres — for sessions a sibling instance created after we loaded. */
  async findSession(by: { hash?: string; id?: string }) {
    return withRetry(() => this.findSessionOnce(by), { label: "findSession" });
  }

  private async findSessionOnce(by: { hash?: string; id?: string }) {
    const r = by.hash
      ? await this.pool.query<SessionRow>("SELECT * FROM sessions WHERE token_hash = $1 OR legacy_hash = $1 OR $1 = ANY(prev_hashes) LIMIT 1", [by.hash])
      : await this.pool.query<SessionRow>("SELECT * FROM sessions WHERE id = $1 ORDER BY last_seen_at DESC LIMIT 1", [by.id]);
    const row = r.rows[0];
    if (!row) return null;
    const session = sessionFromRow(row);
    const u = (await this.pool.query("SELECT * FROM users WHERE id = $1", [row.user_id])).rows[0];
    if (!u) return { session, user: null };
    const interests = (await this.pool.query<{ interest: string }>("SELECT interest FROM user_interests WHERE user_id = $1 ORDER BY position", [u.id])).rows.map((x) => x.interest);
    const user: UserRecord = {
      id: u.id,
      name: u.name,
      username: u.username,
      color: u.color,
      bio: u.bio,
      isBot: false,
      createdAt: u.created_at,
      baseFollowers: u.base_followers,
      baseFollowing: u.base_following,
      ...(u.phone !== null ? { phone: u.phone } : {}),
      interests,
      photoVersion: u.photo_version,
      socialLinks: u.social_links ?? {},
      passwordHash: u.password_hash ?? null,
    };
    return { session, user };
  }

  /** Readiness probe: a trivial round-trip with a short timeout. */
  async ping(timeoutMs = 2000): Promise<{ ok: boolean; ms: number; error?: string }> {
    const t0 = Date.now();
    try {
      await Promise.race([this.pool.query("SELECT 1"), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs))]);
      return { ok: true, ms: Date.now() - t0 };
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, error: errText(err) };
    }
  }

  async status() {
    try {
      const r = await this.pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
      return { connected: true, migrations: r.rows.map((x) => x.version) };
    } catch {
      return { connected: false, migrations: [] };
    }
  }

  async markImported(source: string) {
    await this.pool.query(
      "INSERT INTO openlounge_meta (key, value) VALUES ('json_imported', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      [`${source} @ ${new Date().toISOString()}`],
    );
  }

  async close() {
    await this.pool.end().catch(() => {});
  }
}

interface OtpDbRow {
  otp_key: string;
  email: string;
  purpose: "signin" | "link" | "username";
  user_id: string | null;
  code_hash: string;
  attempts: number;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}
const otpRow = (r: OtpDbRow): EmailOtpRow => ({
  key: r.otp_key,
  email: r.email,
  purpose: r.purpose,
  userId: r.user_id,
  codeHash: r.code_hash,
  attempts: Number(r.attempts),
  createdAt: Number(r.created_at),
  expiresAt: Number(r.expires_at),
  usedAt: r.used_at === null ? null : Number(r.used_at),
});
