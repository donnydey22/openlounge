// Durable storage backends for the in-memory Store.
//
//   DATABASE_URL set   → Postgres (server/pg.ts). This is the production path (Railway Postgres).
//   DATABASE_URL unset → JSON file at DATA_DIR/db.json (local-dev fallback, logged loudly at boot).
//
// The Store keeps everything hot in memory exactly as before and hands the backend a full
// PersistedDb snapshot on a debounce (~800 ms) and on shutdown. The Postgres backend diffs that
// snapshot against what it last wrote and only sends the changed rows.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { DirectMessage } from "../src/lib/types";
import type { ReportRecord } from "./moderation";

export interface UserRecord {
  id: string;
  name: string;
  username: string;
  color: string;
  bio: string;
  isBot: boolean;
  createdAt: number;
  baseFollowers: number;
  baseFollowing: number;
  /** E.164 phone number used to sign in (humans only, never sent to other users) */
  phone?: string;
  interests?: string[];
  /** canonical https URLs keyed by network (see src/lib/socialLinks.ts) */
  socialLinks?: Record<string, string>;
  /** bumped on every upload; null = no photo */
  photoVersion?: number | null;
  /** scrypt hash (server/authx/password.ts) for accounts with an email identity; never leaves the server */
  passwordHash?: string | null;
}

export type IdentityProvider = "phone" | "email" | "google" | "apple";

/** One sign-in method attached to a user (migration 005, table auth_identities). */
export interface IdentityRecord {
  userId: string;
  provider: IdentityProvider;
  /** phone: E.164 · email: lower-cased address · google/apple: the id_token `sub` */
  subject: string;
  /** lower-cased email (for email identities = subject); null when the provider gave none */
  email: string | null;
  verified: boolean;
  createdAt: number;
  lastUsedAt?: number | null;
}

export interface SessionRecord {
  /** SHA-256 of the current refresh token (or of the legacy token for pre-v2 sessions) — table primary key */
  tokenHash: string;
  userId: string;
  createdAt: number;
  /** refresh expiry (sliding) */
  expiresAt: number;
  /** last used */
  lastSeenAt: number;
  // ---- v2 (migration 003). Optional so db.json files from older versions still load. ----
  /** stable session ("family") id, embedded in access tokens */
  id?: string;
  /** 1 = pre-v2 session created by an older server, 2 = rotating refresh token */
  scheme?: number;
  /** hash of the pre-v2 token, still accepted after rotation so existing devices/bots never get signed out */
  legacyHash?: string | null;
  /** rotated-out refresh hashes (newest first) for reuse detection */
  prevHashes?: string[];
  rotatedAt?: number | null;
  /** expiry of the most recently issued access token */
  accessExpiresAt?: number | null;
  /** set = revoked (logout / reuse detected); row kept until expiresAt for reuse detection */
  revokedAt?: number | null;
  /** device / platform label, e.g. "android-app", "web:mac:safari" */
  device?: string;
  /** when the current refresh generation was first used by the client (null = issued, not yet seen in use) */
  confirmedAt?: number | null;
}

export interface PersistedRoom {
  id: string;
  title: string;
  topic: string;
  description: string;
  hostId: string;
  createdAt: number;
}

/** Everything that survives a restart. Same shape as the original db.json. */
export interface PersistedDb {
  version: 1;
  users: UserRecord[];
  follows: Record<string, string[]>;
  rooms: PersistedRoom[];
  dms?: DirectMessage[];
  sessions?: SessionRecord[];
  /** userId -> peerId -> last read timestamp */
  dmReads?: Record<string, Record<string, number>>;
  /** sign-in methods (migration 005). Older db.json files have none: phone identities are derived from users.phone. */
  identities?: IdentityRecord[];
  /** UGC safety (migration 011): who blocked whom */
  blocks?: { blockerId: string; blockedId: string; createdAt: number }[];
  /** UGC safety (migration 011): content reports */
  reports?: ReportRecord[];
}

export interface OneTimeBackend {
  put(table: "reset" | "code", row: { hash: string; purpose: string; userId?: string; email?: string; payload?: unknown; createdAt: number; expiresAt: number }): Promise<void>;
  /** atomically mark used and return the row, or null if unknown / used / expired */
  consume(table: "reset" | "code", hash: string, purpose: string, now: number): Promise<{ userId?: string; email?: string; payload?: unknown } | null>;
  /** a still-usable reset token's owner + address, without consuming it */
  peekReset?(hash: string, now: number): Promise<{ userId: string; email: string } | null>;
  /** mark every unused reset token of a user as used (after a successful reset) */
  supersedeResets(userId: string, now: number): Promise<void>;
}

export interface EmailOtpRow {
  key: string;
  email: string;
  purpose: "signin" | "link";
  userId: string | null;
  codeHash: string;
  attempts: number;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

/** Hashed 6-digit email codes (migration 010). */
export interface EmailOtpBackend {
  get(key: string): Promise<EmailOtpRow | null>;
  /** insert or replace (a resend): attempts back to 0 */
  put(row: Omit<EmailOtpRow, "attempts" | "usedAt">): Promise<void>;
  /** atomically count one attempt on a live code (unused, unexpired, attempts < max); null if none qualifies */
  attempt(key: string, max: number, now: number): Promise<EmailOtpRow | null>;
  /** single use: true only for the caller that marked it */
  markUsed(key: string, codeHash: string, now: number): Promise<boolean>;
}

export class MemoryEmailOtp implements EmailOtpBackend {
  private rows = new Map<string, EmailOtpRow>();
  async get(key: string) {
    const r = this.rows.get(key);
    return r ? { ...r } : null;
  }
  async put(row: Omit<EmailOtpRow, "attempts" | "usedAt">) {
    for (const [k, v] of this.rows) if (v.expiresAt < row.createdAt - 86_400_000) this.rows.delete(k);
    this.rows.set(row.key, { ...row, attempts: 0, usedAt: null });
  }
  async attempt(key: string, max: number, now: number) {
    const r = this.rows.get(key);
    if (!r || r.usedAt !== null || r.expiresAt <= now || r.attempts >= max) return null;
    r.attempts++;
    return { ...r };
  }
  async markUsed(key: string, codeHash: string, now: number) {
    const r = this.rows.get(key);
    if (!r || r.usedAt !== null || r.codeHash !== codeHash) return false;
    r.usedAt = now;
    return true;
  }
}

/** In-memory OneTimeBackend (JSON backend / tests without Postgres). */
export class MemoryOneTime implements OneTimeBackend {
  private rows = new Map<string, { purpose: string; userId?: string; email?: string; payload?: unknown; expiresAt: number; usedAt: number | null }>();
  async put(table: "reset" | "code", row: { hash: string; purpose: string; userId?: string; email?: string; payload?: unknown; createdAt: number; expiresAt: number }) {
    const now = Date.now();
    for (const [k, v] of this.rows) if (v.expiresAt < now - 86_400_000) this.rows.delete(k);
    this.rows.set(`${table}:${row.hash}`, { purpose: row.purpose, userId: row.userId, email: row.email, payload: row.payload, expiresAt: row.expiresAt, usedAt: null });
  }
  async consume(table: "reset" | "code", hash: string, purpose: string, now: number) {
    const r = this.rows.get(`${table}:${hash}`);
    if (!r || r.purpose !== purpose || r.usedAt !== null || r.expiresAt <= now) return null;
    r.usedAt = now;
    return { userId: r.userId, email: r.email, payload: r.payload };
  }
  async peekReset(hash: string, now: number) {
    const r = this.rows.get(`reset:${hash}`);
    return r && r.usedAt === null && r.expiresAt > now && r.userId && r.email ? { userId: r.userId, email: r.email } : null;
  }
  async supersedeResets(userId: string, now: number) {
    for (const [k, r] of this.rows) if (k.startsWith("reset:") && r.userId === userId && r.usedAt === null) r.usedAt = now;
  }
}

export interface LoadResult {
  db: PersistedDb | null;
  /** true when the backend holds no users and has never imported db.json (fresh Postgres) */
  empty: boolean;
}

export interface Persistence {
  kind: "postgres" | "json";
  /** human-readable location for logs (password redacted) */
  where: string;
  load(): Promise<LoadResult>;
  save(db: PersistedDb): Promise<void>;
  /** HMAC secret for access tokens, generated once and kept with the data */
  authSecret?(): Promise<string>;
  /** sessions created by a sibling instance (deploy overlap) that this process hasn't loaded: look up by token hash / session id */
  findSession?(by: { hash?: string; id?: string }): Promise<{ session: SessionRecord; user: UserRecord | null } | null>;
  /** schema/migration status for /api/health */
  status?(): Promise<{ connected: boolean; migrations: string[] }>;
  /**
   * Short-lived single-use secrets (password reset links, email verification links, OAuth exchange codes).
   * Postgres: tables password_reset_tokens / auth_one_time_codes, consumed atomically (UPDATE … WHERE used_at IS NULL),
   * so a token works exactly once even across instances. JSON backend: kept in memory (dev only).
   */
  oneTime?: OneTimeBackend;
  /** hashed 6-digit email codes (Postgres: email_otp_codes; JSON backend: in memory) */
  emailOtp?: EmailOtpBackend;
  /** readiness probe (Postgres only) */
  ping?(timeoutMs?: number): Promise<{ ok: boolean; ms: number; error?: string }>;
  /** record that a db.json import finished (Postgres only) */
  markImported?(source: string): Promise<void>;
  close(): Promise<void>;
}

// DATA_DIR lets a host mount a persistent volume (e.g. Railway volume at /data). Avatars always live here.
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
export const DATA_FILE = path.join(DATA_DIR, "db.json");

/** Readable error text (connection failures are often an AggregateError with an empty message). */
export function errText(err: unknown): string {
  const e = err as { message?: string; code?: string; errors?: unknown[] };
  if (e?.errors?.length) return [...new Set(e.errors.map(errText))].join("; ");
  return [e?.code, e?.message].filter(Boolean).join(" ") || String(err);
}

export function readJsonDb(file: string): PersistedDb | null {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as PersistedDb;
}

/** Original behaviour: whole snapshot to db.json via tmp file + atomic rename. */
export class JsonPersistence implements Persistence {
  kind = "json" as const;
  oneTime = new MemoryOneTime();
  emailOtp = new MemoryEmailOtp();
  constructor(readonly where: string = DATA_FILE) {}

  async load(): Promise<LoadResult> {
    try {
      return { db: readJsonDb(this.where), empty: false };
    } catch (err) {
      console.warn("[store] could not load db.json, starting fresh:", err);
      return { db: null, empty: false };
    }
  }

  async save(db: PersistedDb) {
    try {
      fs.mkdirSync(path.dirname(this.where), { recursive: true });
      const tmp = `${this.where}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, this.where);
    } catch (err) {
      console.warn("[store] save failed:", err);
    }
  }

  async authSecret() {
    const file = path.join(path.dirname(this.where), "auth-secret");
    try {
      const v = fs.readFileSync(file, "utf8").trim();
      if (v) return v;
    } catch {
      /* first boot */
    }
    const v = randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, v, { mode: 0o600 });
    return v;
  }

  async close() {}
}

/** Pick the backend from the environment. */
export async function createPersistence(): Promise<Persistence> {
  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    const { PgPersistence } = await import("./pg");
    const pg = new PgPersistence(url);
    await pg.connectAndMigrate();
    console.log(`[store] storage: Postgres (${pg.where}, TLS ${pg.sslLabel}${pg.tlsActive === null ? "" : pg.tlsActive ? " — encrypted" : " — not encrypted"})`);
    return pg;
  }
  const loud = process.env.NODE_ENV === "production";
  const msg =
    `[store] storage: JSON file ${DATA_FILE} — DATABASE_URL is not set.` +
    (loud
      ? " ⚠️  Production without Postgres: data only survives if DATA_DIR is on a persistent volume. Set DATABASE_URL (Railway Postgres) for durable storage."
      : " (local-dev fallback; set DATABASE_URL to use Postgres)");
  (loud ? console.warn : console.log)(msg);
  return new JsonPersistence();
}
