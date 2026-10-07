// In-memory app state with durable persistence (Postgres when DATABASE_URL is set, else DATA_DIR/db.json).
// Rooms + presence live in memory; users, follows, sessions, DMs, DM read cursors and user-created rooms are persisted.
// All reads are served from memory; writes are flushed to the backend on a debounce (~800 ms) and on shutdown.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "./log";
import { ACCESS_TTL_MS, MAX_PREV_HASHES, REFRESH_TTL_MS, ROTATION_GRACE_MS, isAccessToken, newOpaqueToken, newSessionId, parseAccessToken, configureAuthKeys, sha256, signAccessToken } from "./auth";
import type {
  ChatMessage,
  ConversationSummary,
  DirectMessage,
  DmReadReceipt,
  Participant,
  PublicUser,
  RoomPresenceEvent,
  RoomReaction,
  RoomState,
  RoomSummary,
  UserProfile,
} from "../src/lib/types";
import { AVATAR_COLORS, CHAT_MAX_LENGTH, INTERESTS, MAX_INTERESTS, ROOM_CHAT_HISTORY, ROOM_REACTIONS, TOPICS, USERNAME_RE } from "../src/lib/types";
import type { Me } from "../src/lib/types";
import { maskPhone } from "./otp";
import { BOT_CHAT_LINES, BOT_DM_REPLIES, NOTABLE_USERS, SEED_ROOMS, fillerUsers } from "./seed";
import { conversationId } from "./conversation";
import { normalizeSocialLinks, sanitizeStoredLinks, type SocialKey } from "../src/lib/socialLinks";

/**
 * Demo seeding (bot users, seeded rooms, bot chat, bot DM replies, newcomer waves, bot audiences)
 * is OFF by default so only real users show up. Set DEMO_SEED=1 to bring the demo population back.
 * Bots are memory-only either way (never persisted).
 */
export const DEMO_SEED = /^(1|true|yes)$/i.test(process.env.DEMO_SEED ?? "");
import {
  DATA_DIR,
  DATA_FILE,
  createPersistence,
  errText,
  readJsonDb,
  MemoryOneTime,
  MemoryEmailOtp,
  type EmailOtpBackend,
  type IdentityProvider,
  type IdentityRecord,
  type OneTimeBackend,
  type Persistence,
  type PersistedDb,
  type SessionRecord,
  type UserRecord,
} from "./persistence";

interface ParticipantRecord {
  userId: string;
  role: Participant["role"];
  muted: boolean;
  handRaised: boolean;
  handRaisedAt: number | null;
  speaking: boolean;
  joinedAt: number;
  socketId: string | null; // null for bots or while "away"
}

interface RoomRecord {
  id: string;
  title: string;
  topic: string;
  description: string;
  hostId: string;
  createdAt: number;
  seeded: boolean;
  ended: boolean;
  endedAt: number | null;
  emptySince: number | null;
  /** Speaking priority — who holds the podium right now */
  podiumUserId: string | null;
  participants: Map<string, ParticipantRecord>;
  /** In-room chat, kept for the life of the room (memory only, capped) */
  chat: ChatMessage[];
}

export interface StoreEvents {
  roomChanged(roomId: string): void;
  roomsListChanged(): void;
  roomEnded(roomId: string): void;
  toast(userId: string, message: string): void;
  kickSocket(socketId: string, roomId: string, reason: string): void;
  chatMessage(msg: ChatMessage): void;
  chatDeleted(roomId: string, messageId: string): void;
  dmMessage(msg: DirectMessage): void;
  dmTyping(fromId: string, toId: string): void;
  /** someone saw messages in a DM conversation (read receipt for the sender) */
  dmRead?(receipt: DmReadReceipt): void;
  roomPresence(ev: RoomPresenceEvent): void;
  roomReaction(reaction: RoomReaction): void;
  /** a session was revoked (logout, logout-all, refresh-token reuse): sign its sockets out */
  sessionRevoked?(sessionId: string): void;
  /** the user's own profile changed outside a socket handler (REST): push me:update to their sockets */
  meChanged?(userId: string, user: Me): void;
}

// DATA_DIR (persistence.ts) lets a host mount a persistent volume (e.g. Railway volume at /data) — avatars live there.
const AWAY_GRACE_MS = 45_000; // keep your seat during a refresh / network switch / app backgrounding (LiveKit audio keeps playing)
const EMPTY_ROOM_TTL_MS = 5 * 60_000; // user rooms with no humans end after 5 min
const MAX_BOT_SPEAKERS = 4;
const DM_HISTORY_PER_CONVERSATION = 1000;
const AVATAR_DIR = path.join(DATA_DIR, "avatars");
export const DELETED_USER_ID = "u_deleted";
const DELETED_NAME = "Deleted account";
const DELETED_COLOR = "#64748B";

export { conversationId };

/**
 * Internal QA / test accounts never appear in onboarding follow suggestions (they stay in the database and can
 * still sign in): NANP fictional numbers 555-0100…0199, repeated-digit numbers (+1 111 111 1111), plus anything
 * listed in INTERNAL_TEST_PHONES / INTERNAL_TEST_USER_IDS (comma-separated).
 */
const TEST_PHONES = new Set((process.env.INTERNAL_TEST_PHONES ?? "").split(",").map((x) => x.replace(/[^\d+]/g, "")).filter(Boolean));
const TEST_IDS = new Set((process.env.INTERNAL_TEST_USER_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean));
export function isInternalTestAccount(u: { id: string; phone?: string }) {
  if (TEST_IDS.has(u.id)) return true;
  const p = u.phone ?? "";
  return TEST_PHONES.has(p) || /^\+1\d{3}55501\d{2}$/.test(p) || /^\+(\d)\1{7,14}$/.test(p);
}

export const identityKey = (provider: IdentityProvider, subject: string) => `${provider}|${subject}`;
/** Lower-cased, trimmed email, or null if it doesn't look like one. */
export function normalizeEmail(raw: unknown): string | null {
  const e = String(raw ?? "").trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

const clamp = (s: unknown, max: number) => String(s ?? "").trim().slice(0, max);
const rand = <T,>(arr: T[]): T | undefined => arr[Math.floor(Math.random() * arr.length)];

export class Store {
  users = new Map<string, UserRecord>();
  follows = new Map<string, Set<string>>(); // followerId -> followeeIds
  rooms = new Map<string, RoomRecord>();
  dms = new Map<string, DirectMessage[]>(); // conversationId -> messages (oldest first)
  dmReads = new Map<string, Map<string, number>>(); // userId -> peerId -> last read ts
  sessions = new Map<string, SessionRecord>(); // tokenHash -> session
  /** sign-in methods: "<provider>|<subject>" -> identity (phone numbers included — see migration 005) */
  identities = new Map<string, IdentityRecord>();
  private chatRate = new Map<string, number[]>(); // userId -> recent send timestamps
  private reactionRate = new Map<string, number[]>(); // userId -> recent reaction timestamps
  private awayTimers = new Map<string, NodeJS.Timeout>();
  /** Connections whose app/tab is backgrounded (client "presence:visible" false) → seat shows as "away" */
  private hiddenSockets = new Set<string>();
  private saveTimer: NodeJS.Timeout | null = null;
  private events: StoreEvents | null = null;
  private backend: Persistence | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private retryDelay = 0;

  constructor() {
    if (DEMO_SEED) this.seed();
  }

  /** Storage backend in use ("postgres" | "json"), null before init(). */
  get storageKind() {
    return this.backend?.kind ?? null;
  }

  /**
   * Connect the durable backend and load saved data. Must be awaited before serving traffic.
   * With Postgres, a fresh (empty) database automatically imports DATA_DIR/db.json once if it exists.
   * `importJson` forces a merge-import of a specific db.json (used by `npm run db:import`).
   */
  async init(opts: { importJson?: string } = {}) {
    this.backend = await createPersistence();
    // AUTH_SECRET (env) preferred; the DB/DATA_DIR key is the fallback and stays valid for verification (rotation grace)
    const keys = configureAuthKeys({ dbSecret: (await this.backend.authSecret?.()) ?? null });
    log.info("auth keys", keys);
    const { db, empty } = await this.backend.load();
    if (db) this.hydrate(db, this.backend.kind === "postgres" ? "Postgres" : DATA_FILE);

    const auto = this.backend.kind === "postgres" && empty && !opts.importJson && process.env.SKIP_JSON_IMPORT !== "1" && fs.existsSync(DATA_FILE);
    const source = opts.importJson ? path.resolve(opts.importJson) : auto ? DATA_FILE : null;
    if (source && this.backend.kind === "postgres") {
      const legacy = readJsonDb(source);
      if (!legacy) throw new Error(`[store] ${source} not found`);
      console.log(`[store] importing ${source} into Postgres${auto ? " (fresh database, one-time)" : ""}…`);
      this.hydrate(legacy, source);
      await this.flush();
      await this.backend.markImported?.(source);
      console.log(`[store] import done — ${source} is no longer read and can be archived`);
    }
  }

  attach(events: StoreEvents) {
    this.events = events;
    // unref: the simulation tick must never keep the process alive on shutdown (and tests exit cleanly)
    setInterval(() => this.tick(), 1500).unref();
  }

  // ---------- seeding & persistence ----------

  private seed() {
    const now = Date.now();
    for (const u of [...NOTABLE_USERS, ...fillerUsers()]) {
      this.users.set(u.id, {
        ...u,
        username: this.uniqueUsername(u.name),
        isBot: true,
        createdAt: now - 1000 * 60 * 60 * 24 * 200,
      });
    }
    // a few bot-to-bot follows so profiles have lists
    const notableIds = NOTABLE_USERS.map((u) => u.id);
    for (const id of notableIds) {
      this.follows.set(id, new Set(notableIds.filter((x) => x !== id && Math.random() < 0.4)));
    }
    const fillers = [...this.users.values()].filter((u) => u.id.startsWith("bot-f")).map((u) => u.id);
    let cursor = 0;
    for (const sr of SEED_ROOMS) {
      const room: RoomRecord = {
        id: sr.id,
        title: sr.title,
        topic: sr.topic,
        description: sr.description,
        hostId: sr.hostId,
        createdAt: now - sr.ageMinutes * 60_000,
        seeded: true,
        ended: false,
        endedAt: null,
        emptySince: null,
        podiumUserId: sr.hostId,
        participants: new Map(),
        chat: [],
      };
      this.addBot(room, sr.hostId, "host");
      for (const s of sr.speakerIds) this.addBot(room, s, "speaker");
      for (let i = 0; i < sr.listenerCount; i++) this.addBot(room, fillers[cursor++ % fillers.length], "listener");
      // a little backlog so the chat isn't empty on first open
      const ids = [...room.participants.keys()];
      for (let i = 0; i < 6; i++) {
        const author = ids[(i * 5 + 2) % ids.length];
        this.pushChat(room, author, BOT_CHAT_LINES[(i * 7 + sr.id.length) % BOT_CHAT_LINES.length], now - (6 - i) * 95_000);
      }
      this.rooms.set(room.id, room);
    }
  }

  /** Merge a persisted snapshot into memory (boot load, or a db.json import on top of Postgres data). */
  private hydrate(db: PersistedDb, from: string) {
    try {
      for (const u of db.users ?? []) {
        // older demo users (pre phone-auth) get a generated handle
        this.users.set(u.id, { ...u, isBot: false, username: u.username || this.uniqueUsername(u.name) });
      }
      for (const i of db.identities ?? []) if (this.users.has(i.userId)) this.identities.set(identityKey(i.provider, i.subject), { ...i });
      // every phone number is a phone identity (db.json files and rows written by a pre-005 server have none yet)
      for (const u of db.users ?? []) if (u.phone) this.ensurePhoneIdentity(u.id, u.phone, u.createdAt);
      const now0 = Date.now();
      const legacyOf = new Set((db.sessions ?? []).map((s) => s.legacyHash).filter((h): h is string => !!h));
      for (const s of db.sessions ?? []) {
        if (s.expiresAt <= now0 || !this.users.has(s.userId)) continue;
        // a pre-v2 row re-inserted by the previous deploy's final flush after we rotated it: same session, skip the duplicate
        if ((s.scheme ?? 1) === 1 && legacyOf.has(s.tokenHash) && (db.sessions ?? []).some((o) => o !== s && o.legacyHash === s.tokenHash && o.tokenHash !== s.tokenHash)) continue;
        this.indexSession(s);
      }
      for (const [k, v] of Object.entries(db.follows ?? {})) this.follows.set(k, new Set(v));
      const now = Date.now();
      for (const r of db.rooms ?? []) {
        if (this.rooms.has(r.id)) continue;
        this.rooms.set(r.id, {
          ...r,
          seeded: false,
          ended: false,
          endedAt: null,
          emptySince: now,
          podiumUserId: r.hostId,
          participants: new Map(),
          chat: [],
        });
      }
      const seen = new Set<string>();
      for (const list of this.dms.values()) for (const m of list) seen.add(m.id);
      for (const m of db.dms ?? []) {
        if (seen.has(m.id)) continue; // merge-import: skip messages already loaded
        const key = conversationId(m.fromId, m.toId);
        const list = this.dms.get(key) ?? [];
        list.push(m);
        this.dms.set(key, list);
      }
      for (const list of this.dms.values()) list.sort((a, b) => a.createdAt - b.createdAt);
      for (const [uid, reads] of Object.entries(db.dmReads ?? {})) {
        const mine = this.dmReads.get(uid) ?? new Map<string, number>();
        for (const [peer, ts] of Object.entries(reads)) mine.set(peer, Math.max(ts, mine.get(peer) ?? 0));
        this.dmReads.set(uid, mine);
      }
      console.log(`[store] loaded ${db.users?.length ?? 0} users, ${db.rooms?.length ?? 0} rooms, ${db.dms?.length ?? 0} DMs from ${from}`);
    } catch (err) {
      console.warn(`[store] could not load data from ${from}, starting fresh:`, err);
    }
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 800);
  }

  /**
   * Persist now. Called on a debounce and on shutdown. Saves are serialized; each one snapshots memory
   * when it runs. Postgres writes only changed rows; JSON rewrites db.json (atomic tmp + rename).
   * A failed Postgres write is retried with backoff (memory stays authoritative meanwhile).
   */
  flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const run = this.flushChain.then(() => this.saveSnapshot());
    this.flushChain = run.catch(() => {});
    return this.flushChain;
  }

  private async saveSnapshot() {
    const backend = this.backend;
    if (!backend) return;
    try {
      await backend.save(this.snapshot());
      this.retryDelay = 0;
    } catch (err) {
      this.retryDelay = Math.min(this.retryDelay ? this.retryDelay * 2 : 2000, 60_000);
      console.error(`[store] ${backend.kind} save failed, retrying in ${this.retryDelay / 1000}s: ${errText(err)}`);
      if (!this.saveTimer) this.saveTimer = setTimeout(() => this.flush(), this.retryDelay);
      throw err;
    }
  }

  /** Close the backend (after a final flush). */
  async close() {
    await this.flush();
    await this.backend?.close();
  }

  private snapshot(): PersistedDb {
    return {
      version: 1,
      users: [...this.users.values()].filter((u) => !u.isBot),
      follows: Object.fromEntries(
        [...this.follows.entries()].filter(([k]) => !k.startsWith("bot-")).map(([k, v]) => [k, [...v]]),
      ),
      rooms: [...this.rooms.values()]
        .filter((r) => !r.seeded && !r.ended)
        .map(({ id, title, topic, description, hostId, createdAt }) => ({ id, title, topic, description, hostId, createdAt })),
      dms: [...this.dms.values()].flat(),
      dmReads: Object.fromEntries([...this.dmReads.entries()].map(([k, v]) => [k, Object.fromEntries(v)])),
      sessions: [...this.sessions.values()],
      identities: [...this.identities.values()].filter((i) => this.users.has(i.userId) && !this.users.get(i.userId)!.isBot),
    };
  }

  // ---------- users ----------

  // ----- accounts (phone auth) -----

  /** Phone sign-in: the phone identity decides the account (users.phone is its mirror, kept as a fallback). */
  userByPhone(phone: string) {
    const id = this.identities.get(identityKey("phone", phone));
    if (id) {
      const u = this.users.get(id.userId);
      if (u) return u;
    }
    for (const u of this.users.values()) if (u.phone === phone) return u;
    return null;
  }

  // ----- sign-in identities (unified accounts: phone / email / google / apple) -----

  findIdentity(provider: IdentityProvider, subject: string): IdentityRecord | null {
    return this.identities.get(identityKey(provider, subject)) ?? null;
  }

  identitiesOf(userId: string): IdentityRecord[] {
    return [...this.identities.values()].filter((i) => i.userId === userId).sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * The one account that owns a VERIFIED identity with this email (any provider), for automatic linking.
   * null when nobody does — or when two different accounts do (ambiguous: never guess).
   */
  userByVerifiedEmail(email: string | null | undefined): string | null {
    const e = normalizeEmail(email);
    if (!e) return null;
    const owners = new Set<string>();
    for (const i of this.identities.values()) if (i.verified && i.email === e && this.users.has(i.userId)) owners.add(i.userId);
    return owners.size === 1 ? [...owners][0] : null;
  }

  private ensurePhoneIdentity(userId: string, phone: string, at = Date.now()) {
    const k = identityKey("phone", phone);
    if (this.identities.has(k)) return;
    this.identities.set(k, { userId, provider: "phone", subject: phone, email: null, verified: true, createdAt: at, lastUsedAt: null });
  }

  /**
   * Attach a sign-in method to an account. Fails if that (provider, subject) belongs to someone else.
   * A phone identity also sets users.phone (one phone number per account).
   */
  addIdentity(userId: string, rec: { provider: IdentityProvider; subject: string; email?: string | null; verified: boolean }) {
    const u = this.users.get(userId);
    if (!u || u.isBot) return { ok: false as const, code: "no_user" as const, error: "Account not found" };
    const k = identityKey(rec.provider, rec.subject);
    const existing = this.identities.get(k);
    if (existing && existing.userId !== userId) return { ok: false as const, code: "taken" as const, error: "That sign-in method is already linked to another Open Lounge account." };
    if (rec.provider === "phone") {
      const other = this.userByPhone(rec.subject);
      if (other && other.id !== userId) return { ok: false as const, code: "taken" as const, error: "That number is already linked to another Open Lounge account." };
      if (u.phone && u.phone !== rec.subject) return { ok: false as const, code: "has_phone" as const, error: "Your account already has a phone number." };
      u.phone = rec.subject;
    }
    const now = Date.now();
    const email = normalizeEmail(rec.email);
    if (existing) {
      existing.email = email ?? existing.email;
      existing.verified = existing.verified || rec.verified;
    } else {
      this.identities.set(k, { userId, provider: rec.provider, subject: rec.subject, email, verified: rec.verified, createdAt: now, lastUsedAt: null });
    }
    this.scheduleSave();
    return { ok: true as const, identity: this.identities.get(k)! };
  }

  /** Detach a sign-in method. The last remaining method can't be removed (the account would be unreachable). */
  removeIdentity(userId: string, provider: IdentityProvider, subject: string) {
    const k = identityKey(provider, subject);
    const i = this.identities.get(k);
    if (!i || i.userId !== userId) return { ok: false as const, error: "That sign-in method isn't on your account." };
    if (this.identitiesOf(userId).length <= 1) return { ok: false as const, error: "Add another way to sign in before removing this one." };
    this.identities.delete(k);
    const u = this.users.get(userId)!;
    if (provider === "phone" && u.phone === subject) delete u.phone;
    if (provider === "email" && !this.identitiesOf(userId).some((x) => x.provider === "email")) u.passwordHash = null;
    this.scheduleSave();
    return { ok: true as const };
  }

  touchIdentity(provider: IdentityProvider, subject: string, at = Date.now()) {
    const i = this.identities.get(identityKey(provider, subject));
    if (!i) return;
    i.lastUsedAt = at;
    this.scheduleSave();
  }

  passwordHashOf(userId: string) {
    return this.users.get(userId)?.passwordHash ?? null;
  }

  setPasswordHash(userId: string, hash: string | null) {
    const u = this.users.get(userId);
    if (!u || u.isBot) return false;
    u.passwordHash = hash;
    this.scheduleSave();
    return true;
  }

  /** Short-lived single-use secrets (reset links, verification links, exchange codes). */
  private memOneTime = new MemoryOneTime();
  get oneTime(): OneTimeBackend {
    return this.backend?.oneTime ?? this.memOneTime;
  }
  private memEmailOtp = new MemoryEmailOtp();
  get emailOtp(): EmailOtpBackend {
    return this.backend?.emailOtp ?? this.memEmailOtp;
  }

  private uniqueUsername(name: string) {
    const base = (name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16) || "member").padEnd(3, "0");
    let candidate = base;
    for (let i = 2; !this.usernameAvailable(candidate); i++) candidate = `${base}${i}`;
    return candidate;
  }

  normalizeUsername(raw: unknown) {
    return String(raw ?? "")
      .trim()
      .replace(/^@/, "")
      .toLowerCase();
  }

  usernameAvailable(username: string, exceptUserId?: string) {
    for (const u of this.users.values()) if (u.username === username && u.id !== exceptUserId) return false;
    return true;
  }

  checkUsername(raw: unknown, exceptUserId?: string) {
    const username = this.normalizeUsername(raw);
    if (!USERNAME_RE.test(username)) return { username, available: false, reason: "3–20 characters: letters, numbers, underscores" };
    if (!this.usernameAvailable(username, exceptUserId)) return { username, available: false, reason: `@${username} is taken` };
    return { username, available: true, reason: null };
  }

  /**
   * New account. Phone signups pass the verified number (as before); email / Google / Apple signups pass
   * phone = null plus the identity that proved who they are (and the password hash for email).
   */
  createAccount(
    phone: string | null,
    input: { firstName?: string; lastName?: string; username?: string; bio?: string; color?: string; interests?: unknown },
    extra: { identity?: { provider: IdentityProvider; subject: string; email?: string | null; verified: boolean }; passwordHash?: string | null } = {},
  ) {
    if (phone && this.userByPhone(phone)) return { ok: false as const, error: "An account already exists for this number — sign in instead." };
    if (extra.identity && this.findIdentity(extra.identity.provider, extra.identity.subject))
      return { ok: false as const, error: "An account already exists for this sign-in — sign in instead." };
    if (!phone && !extra.identity) return { ok: false as const, error: "Your verification expired — please start again." };
    const first = clamp(input.firstName, 24);
    const last = clamp(input.lastName, 24);
    if (first.length < 1) return { ok: false as const, error: "What's your first name?" };
    const u = this.checkUsername(input.username);
    if (!u.available) return { ok: false as const, error: u.reason ?? "Pick another username" };
    const user: UserRecord = {
      id: `u_${randomUUID()}`,
      name: [first, last].filter(Boolean).join(" "),
      username: u.username,
      color: AVATAR_COLORS.includes(input.color as never) ? (input.color as string) : AVATAR_COLORS[0],
      bio: clamp(input.bio, 280),
      isBot: false,
      createdAt: Date.now(),
      baseFollowers: 0,
      baseFollowing: 0,
      ...(phone ? { phone } : {}),
      interests: this.cleanInterests(input.interests),
      photoVersion: null,
      passwordHash: extra.passwordHash ?? null,
    };
    this.users.set(user.id, user);
    if (phone) this.ensurePhoneIdentity(user.id, phone, user.createdAt);
    if (extra.identity) this.addIdentity(user.id, extra.identity);
    this.scheduleSave();
    return { ok: true as const, user };
  }

  private cleanInterests(raw: unknown) {
    return Array.isArray(raw) ? raw.filter((x): x is string => INTERESTS.includes(x as never)).slice(0, MAX_INTERESTS) : [];
  }

  // ----- sessions (v2: access + rotating refresh tokens; see server/auth.ts) -----

  /** secondary lookups: legacy token hash / rotated-out refresh hash -> session; session id -> session */
  private sessionAlias = new Map<string, SessionRecord>();
  private sessionById = new Map<string, SessionRecord>();
  /** recently-missed hashes/ids (avoid hitting Postgres for every garbage token) */
  private sessionMiss = new Map<string, number>();

  private indexSession(s: SessionRecord) {
    s.id ??= `s_${s.tokenHash.slice(0, 32)}`;
    s.scheme ??= 1;
    if (s.legacyHash === undefined) s.legacyHash = s.scheme === 1 ? s.tokenHash : null;
    s.prevHashes ??= [];
    this.sessions.set(s.tokenHash, s);
    this.sessionById.set(s.id, s);
    if (s.legacyHash && s.legacyHash !== s.tokenHash) this.sessionAlias.set(s.legacyHash, s);
    for (const h of s.prevHashes) this.sessionAlias.set(h, s);
  }

  private dropSession(s: SessionRecord) {
    this.sessions.delete(s.tokenHash);
    if (this.sessionById.get(s.id!) === s) this.sessionById.delete(s.id!);
    for (const [h, x] of this.sessionAlias) if (x === s) this.sessionAlias.delete(h);
  }

  private issue(s: SessionRecord, now = Date.now()) {
    const accessExpiresAt = now + ACCESS_TTL_MS;
    s.accessExpiresAt = accessExpiresAt;
    return { access: signAccessToken(s.id!, accessExpiresAt), accessExpiresAt, refreshExpiresAt: s.expiresAt, sessionId: s.id! };
  }

  /** New sign-in. `token` (= the refresh token) is kept in the response for clients older than v2. */
  createSession(userId: string, device = "") {
    const refresh = newOpaqueToken();
    const now = Date.now();
    const s: SessionRecord = {
      tokenHash: sha256(refresh),
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + REFRESH_TTL_MS,
      id: newSessionId(),
      scheme: 2,
      legacyHash: null,
      prevHashes: [],
      rotatedAt: null,
      accessExpiresAt: null,
      revokedAt: null,
      device,
    };
    this.indexSession(s);
    this.scheduleSave();
    return { token: refresh, refresh, ...this.issue(s, now) };
  }

  /** Session from memory, else from Postgres (a sibling instance may have created it during a deploy overlap). */
  private async findSession(by: { hash?: string; id?: string }): Promise<SessionRecord | null> {
    const inMem = by.hash ? (this.sessions.get(by.hash) ?? this.sessionAlias.get(by.hash)) : this.sessionById.get(by.id!);
    if (inMem) return inMem;
    const missKey = by.hash ?? by.id!;
    const missAt = this.sessionMiss.get(missKey);
    if (missAt && Date.now() - missAt < 30_000) return null;
    if (!this.backend?.findSession) return null;
    try {
      const found = await this.backend.findSession(by);
      if (!found || found.session.expiresAt <= Date.now()) {
        this.sessionMiss.set(missKey, Date.now());
        if (this.sessionMiss.size > 5000) this.sessionMiss.clear();
        return null;
      }
      // re-check memory (another request may have loaded it while we awaited)
      const again = this.sessions.get(found.session.tokenHash) ?? this.sessionById.get(found.session.id!);
      if (again) {
        // Same session, but a sibling instance rotated (or revoked) it after we loaded it: Postgres is newer.
        // Keeping our stale copy would make the client's fresh refresh token look like reuse.
        const newer = (found.session.rotatedAt ?? 0) > (again.rotatedAt ?? 0) || (!!found.session.revokedAt && !again.revokedAt);
        if (!newer) return again;
        this.dropSession(again);
        this.indexSession(found.session);
        console.log(`[auth] session ${found.session.id} refreshed from Postgres (updated by another instance)`);
        return found.session;
      }
      if (found.user && !this.users.has(found.user.id)) {
        this.users.set(found.user.id, found.user);
        if (found.user.phone) this.ensurePhoneIdentity(found.user.id, found.user.phone, found.user.createdAt);
      }
      if (!this.users.has(found.session.userId)) return null;
      this.indexSession(found.session);
      console.log(`[auth] loaded session ${found.session.id} from Postgres (created by another instance)`);
      return found.session;
    } catch (err) {
      console.warn("[auth] session lookup failed:", errText(err));
      throw err; // caller treats as transient (never as "signed out")
    }
  }

  private usable(s: SessionRecord | null, now = Date.now()): "ok" | "revoked" | "expired" | "invalid" {
    if (!s || !this.users.has(s.userId)) return "invalid";
    if (s.revokedAt) return "revoked";
    if (s.expiresAt <= now) return "expired";
    return "ok";
  }

  private touch(s: SessionRecord, now = Date.now()) {
    s.lastSeenAt = Math.max(s.lastSeenAt, now);
    s.expiresAt = Math.max(s.expiresAt, now + REFRESH_TTL_MS); // sliding refresh window
    this.scheduleSave();
  }

  /**
   * Validate a credential presented by a client: an access token (v2), or — for clients/bots older than v2 —
   * a legacy session token or the session's current refresh token. Returns a machine-readable reason on failure.
   * Throws only on a transient backend error.
   */
  async authenticate(token: unknown): Promise<{ ok: true; userId: string; sessionId: string; accessExpiresAt: number | null } | { ok: false; reason: "invalid" | "expired" | "revoked" }> {
    if (typeof token !== "string" || token.length < 20 || token.length > 400) return { ok: false, reason: "invalid" };
    const now = Date.now();
    if (isAccessToken(token)) {
      const p = parseAccessToken(token);
      if (!p.ok) {
        // an expired access token for a dead session is "invalid", not "expired" (nothing to refresh)
        if (p.reason === "expired" && p.sessionId) {
          const s = await this.findSession({ id: p.sessionId });
          const u = this.usable(s, now);
          return { ok: false, reason: u === "ok" ? "expired" : u };
        }
        return { ok: false, reason: "invalid" };
      }
      const s = await this.findSession({ id: p.sessionId });
      const u = this.usable(s, now);
      if (u !== "ok") return { ok: false, reason: u };
      // the newest access token is in use → the client definitely holds the newest refresh token
      if (!s!.confirmedAt && p.expiresAt === s!.accessExpiresAt) s!.confirmedAt = now;
      this.touch(s!, now);
      return { ok: true, userId: s!.userId, sessionId: s!.id!, accessExpiresAt: p.expiresAt };
    }
    const h = sha256(token);
    const s = await this.findSession({ hash: h });
    // accepted directly: the legacy (pre-v2) token, or the current refresh token. Rotated-out refresh tokens are not.
    if (!s || (s.tokenHash !== h && s.legacyHash !== h)) return { ok: false, reason: "invalid" };
    const u = this.usable(s, now);
    if (u !== "ok") return { ok: false, reason: u };
    if (!s.confirmedAt && s.tokenHash === h) s.confirmedAt = now;
    this.touch(s, now);
    return { ok: true, userId: s.userId, sessionId: s.id!, accessExpiresAt: null };
  }

  /**
   * Exchange a refresh (or legacy) token for a new access token + a new refresh token (rotation).
   * Re-presenting a rotated-out refresh token after the grace window = theft → the whole session is revoked.
   */
  async refreshSession(token: unknown, device?: string) {
    type Fail = { ok: false; reason: "invalid" | "expired" | "revoked" | "reused" };
    if (typeof token !== "string" || token.length < 20 || token.length > 400 || isAccessToken(token)) return { ok: false, reason: "invalid" } as Fail;
    const now = Date.now();
    const h = sha256(token);
    const s = await this.findSession({ hash: h });
    const u = this.usable(s, now);
    if (u !== "ok") return { ok: false, reason: u } as Fail;
    const sess = s!;
    const isCurrent = sess.tokenHash === h;
    const isLegacy = sess.legacyHash === h;
    if (!isCurrent && !isLegacy) {
      // The immediately-previous refresh token is still fine (1) for a couple of minutes after rotating (two tabs
      // refreshing at once) and (2) for as long as the client has never used what we rotated it to — i.e. the
      // /auth/refresh response was lost (app backgrounded/killed mid-request, network drop). Anything else is reuse.
      const isPrev = sess.prevHashes?.[0] === h;
      const inGrace = isPrev && ((sess.rotatedAt != null && now - sess.rotatedAt <= ROTATION_GRACE_MS) || !sess.confirmedAt);
      if (!inGrace) {
        sess.revokedAt = now;
        this.scheduleSave();
        console.warn(`[auth] refresh-token reuse on session ${sess.id} (user ${sess.userId}) — session revoked`);
        this.events?.sessionRevoked?.(sess.id!);
        return { ok: false, reason: "reused" } as Fail;
      }
    }
    // rotate
    const refresh = newOpaqueToken();
    this.dropSession(sess);
    // presenting the previous token again (lost response) must not push the current, never-delivered one into prevHashes[0]
    const lostResponse = !isCurrent && !isLegacy && !sess.confirmedAt;
    if (lostResponse) {
      // the never-delivered token is dropped; the replayed one stays "previous" so another lost response is fine too
      sess.prevHashes = [h, ...(sess.prevHashes ?? []).filter((x) => x !== h && x !== sess.tokenHash)].slice(0, MAX_PREV_HASHES);
    } else if (sess.tokenHash !== sess.legacyHash) {
      sess.prevHashes = [sess.tokenHash, ...(sess.prevHashes ?? [])].slice(0, MAX_PREV_HASHES);
    }
    sess.tokenHash = sha256(refresh);
    sess.scheme = 2;
    sess.rotatedAt = now;
    sess.confirmedAt = null;
    if (device && !sess.device) sess.device = device;
    this.indexSession(sess);
    this.touch(sess, now);
    return { ok: true as const, refresh, token: refresh, userId: sess.userId, ...this.issue(sess, now) };
  }

  /** Revoke one session (logout) or all of a user's sessions. Returns the revoked session ids. */
  revokeSession(sessionId: string | undefined, opts: { allForUser?: string } = {}) {
    const now = Date.now();
    const out: string[] = [];
    for (const s of this.sessionById.values()) {
      if (s.revokedAt) continue;
      if (s.id === sessionId || (opts.allForUser && s.userId === opts.allForUser)) {
        s.revokedAt = now;
        out.push(s.id!);
      }
    }
    if (out.length) this.scheduleSave();
    for (const id of out) this.events?.sessionRevoked?.(id);
    return out;
  }

  /** Is this session still usable (not revoked/expired)? Used to re-validate long-lived sockets. */
  sessionActive(sessionId: string | undefined, now = Date.now()) {
    if (!sessionId) return false;
    const s = this.sessionById.get(sessionId);
    return !!s && this.usable(s, now) === "ok";
  }

  /** Readiness: DB round-trip (JSON backend is always ready once loaded). */
  async ping(timeoutMs = 2000) {
    if (!this.backend) return { ok: false, ms: 0, error: "not initialized" };
    return this.backend.ping ? this.backend.ping(timeoutMs) : { ok: true, ms: 0 };
  }

  /** Record when a session was last active (presence "last seen"); persisted with the session row. */
  touchSession(sessionId: unknown, at = Date.now()) {
    if (typeof sessionId !== "string") return;
    const s = this.sessionById.get(sessionId);
    if (!s || s.lastSeenAt >= at) return;
    s.lastSeenAt = at;
    this.scheduleSave();
  }

  /** Most recent activity per user (max session last_seen_at) — seeds presence "last seen" after a restart. */
  lastSeenByUser(): Map<string, number> {
    const out = new Map<string, number>();
    for (const s of this.sessions.values()) if ((out.get(s.userId) ?? 0) < s.lastSeenAt) out.set(s.userId, s.lastSeenAt);
    return out;
  }

  /** Storage + schema status for /api/health (no secrets). */
  async storageStatus() {
    const st = (await this.backend?.status?.()) ?? { connected: this.backend?.kind === "json", migrations: [] as string[] };
    let active = 0;
    for (const s of this.sessions.values()) if (!s.revokedAt) active++;
    return { ...st, sessions: active };
  }

  // ----- account deletion (App Store 5.1.1(v)) -----

  /**
   * Permanently delete a member: sessions (tokens), sign-in identities, follows (both directions), read markers,
   * interests, avatar and the user row. DMs they sent are kept for the other person but anonymised
   * ("Deleted account"); rooms they hosted are ended and re-attributed to a placeholder host.
   * Device tokens, notification prefs and contact hashes live in the push repo and are removed by the caller.
   */
  deleteAccount(userId: string) {
    const u = this.users.get(userId);
    if (!u || u.isBot) return { ok: false as const, status: 404, error: "Account not found" };
    const revoked = this.revokeSession(undefined, { allForUser: userId });
    for (const s of [...this.sessions.values()]) if (s.userId === userId) this.dropSession(s);
    for (const [k, idn] of [...this.identities]) if (idn.userId === userId) this.identities.delete(k);
    this.follows.delete(userId);
    for (const set of this.follows.values()) set.delete(userId);
    this.dmReads.delete(userId);
    for (const m of this.dmReads.values()) m.delete(userId);
    for (const list of this.dms.values())
      for (const m of list)
        if (m.fromId === userId) {
          m.fromName = DELETED_NAME;
          m.fromColor = DELETED_COLOR;
        }
    for (const r of this.rooms.values())
      if (r.hostId === userId) {
        r.hostId = DELETED_USER_ID;
        r.ended = true;
      }
    fs.rmSync(path.join(AVATAR_DIR, `${userId}.img`), { force: true });
    fs.rmSync(path.join(AVATAR_DIR, `${userId}.type`), { force: true });
    this.users.delete(userId);
    this.scheduleSave();
    return { ok: true as const, revokedSessions: revoked.length };
  }

  // ----- profile -----

  /** Accepts a client-resized JPEG/PNG/WebP data URL (≤ 400 KB) and stores it under data/avatars. */
  setPhoto(userId: string, dataUrl: unknown) {
    const u = this.users.get(userId);
    if (!u || u.isBot) return { ok: false as const, error: "Not allowed" };
    if (dataUrl === null) {
      u.photoVersion = null;
      fs.rmSync(path.join(AVATAR_DIR, `${userId}.img`), { force: true });
    } else {
      const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ""));
      if (!m) return { ok: false as const, error: "Unsupported image" };
      const buf = Buffer.from(m[2], "base64");
      if (buf.length > 400_000) return { ok: false as const, error: "Image is too large" };
      fs.mkdirSync(AVATAR_DIR, { recursive: true });
      fs.writeFileSync(path.join(AVATAR_DIR, `${userId}.img`), buf);
      fs.writeFileSync(path.join(AVATAR_DIR, `${userId}.type`), `image/${m[1]}`);
      u.photoVersion = Date.now();
    }
    this.scheduleSave();
    this.broadcastUserChange(userId);
    return { ok: true as const };
  }

  /** Path + mime of a stored avatar (used by the HTTP server). */
  avatarFile(userId: string) {
    if (!/^u_[\w-]+$/.test(userId)) return null;
    const file = path.join(AVATAR_DIR, `${userId}.img`);
    if (!fs.existsSync(file)) return null;
    const typeFile = path.join(AVATAR_DIR, `${userId}.type`);
    return { file, type: fs.existsSync(typeFile) ? fs.readFileSync(typeFile, "utf8") : "image/jpeg" };
  }

  private photoUrl(u: UserRecord) {
    return u.photoVersion ? `/avatars/${u.id}?v=${u.photoVersion}` : null;
  }

  private broadcastUserChange(id: string) {
    for (const r of this.rooms.values()) if (r.participants.has(id)) this.events?.roomChanged(r.id);
    this.events?.roomsListChanged();
  }

  updateUser(id: string, patch: { name?: string; bio?: string; color?: string; username?: string; interests?: unknown }) {
    const u = this.users.get(id);
    if (!u || u.isBot) return { ok: false as const, error: "Could not update profile" };
    if (patch.username !== undefined) {
      const check = this.checkUsername(patch.username, id);
      if (!check.available) return { ok: false as const, error: check.reason ?? "Username unavailable" };
      u.username = check.username;
    }
    if (patch.name !== undefined && clamp(patch.name, 48)) u.name = clamp(patch.name, 48);
    if (patch.bio !== undefined) u.bio = clamp(patch.bio, 280);
    if (patch.color && AVATAR_COLORS.includes(patch.color as never)) u.color = patch.color;
    if (patch.interests !== undefined) u.interests = this.cleanInterests(patch.interests);
    this.scheduleSave();
    this.broadcastUserChange(id);
    return { ok: true as const, user: this.me(id)! };
  }

  /** Social links: 10 saves / minute per user (same sliding-window pattern as chat). */
  private socialRate = new Map<string, number[]>();
  updateSocialLinks(id: string, input: unknown) {
    const u = this.users.get(id);
    if (!u || u.isBot) return { ok: false as const, status: 404, error: "Could not update profile" };
    const now = Date.now();
    const recent = (this.socialRate.get(id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 10) {
      this.socialRate.set(id, recent);
      return { ok: false as const, status: 429, error: "Slow down a little 🙂" };
    }
    recent.push(now);
    this.socialRate.set(id, recent);
    const r = normalizeSocialLinks(input, u.socialLinks ?? {});
    if (!r.ok) return { ok: false as const, status: 400, error: r.error, errors: r.errors as Partial<Record<SocialKey, string>> };
    u.socialLinks = r.links;
    this.scheduleSave();
    this.broadcastUserChange(id);
    const me = this.me(id)!;
    this.events?.meChanged?.(id, me);
    return { ok: true as const, user: me };
  }

  me(id: string): Me | null {
    const pub = this.publicUser(id);
    const u = this.users.get(id);
    if (!pub || !u) return null;
    return { ...pub, phoneMasked: u.phone ? maskPhone(u.phone) : null };
  }

  /**
   * Follow suggestions for onboarding: real (non-bot) users other than the viewer and people they
   * already follow — shared interests first, then most followed, then newest. May be empty.
   * With DEMO_SEED=1 the notable demo users are appended after the real people.
   */
  suggestions(userId: string) {
    const mine = new Set(this.users.get(userId)?.interests ?? []);
    const already = new Set(this.followingIds(userId));
    const real = [...this.users.values()]
      .filter((u) => !u.isBot && u.id !== userId && !already.has(u.id) && !isInternalTestAccount(u))
      .map((u) => this.publicUser(u.id)!)
      .map((u) => ({ u, shared: u.interests.filter((i) => mine.has(i)).length }))
      .sort((a, b) => b.shared - a.shared || b.u.followers - a.u.followers || b.u.createdAt - a.u.createdAt)
      .map((x) => x.u);
    if (!DEMO_SEED) return real;
    const roomTopicOf = new Map<string, string>();
    for (const r of this.rooms.values()) for (const p of r.participants.values()) if (p.role !== "listener") roomTopicOf.set(p.userId, r.topic);
    const topics = new Set([...mine].map((i) => i.split(" ").slice(1).join(" ")));
    const demo = NOTABLE_USERS.filter((n) => n.id !== userId && !already.has(n.id))
      .map((n) => this.publicUser(n.id))
      .filter((u): u is PublicUser => !!u)
      .map((u) => ({ u, score: topics.has(roomTopicOf.get(u.id) ?? "") ? 0 : 1 }))
      .sort((a, b) => a.score - b.score || b.u.followers - a.u.followers)
      .map((x) => x.u);
    return [...real, ...demo];
  }

  /** Followers that still exist (saved follows may point at demo bots that aren't loaded). */
  followerIds(id: string) {
    const out: string[] = [];
    for (const [follower, set] of this.follows) if (set.has(id) && this.users.has(follower)) out.push(follower);
    return out;
  }

  /** Followees that still exist; references to missing users (e.g. unseeded "bot-*" ids) are skipped, not deleted. */
  followingIds(id: string) {
    return [...(this.follows.get(id) ?? [])].filter((x) => this.users.has(x));
  }

  publicUser(id: string): PublicUser | null {
    const u = this.users.get(id);
    if (!u) return null;
    return {
      id: u.id,
      name: u.name,
      username: u.username,
      color: u.color,
      photoUrl: this.photoUrl(u),
      interests: u.interests ?? [],
      bio: u.bio,
      socialLinks: sanitizeStoredLinks(u.socialLinks),
      isBot: u.isBot,
      createdAt: u.createdAt,
      followers: u.baseFollowers + this.followerIds(id).length,
      following: u.baseFollowing + this.followingIds(id).length,
    };
  }

  profile(id: string): UserProfile | null {
    const user = this.publicUser(id);
    if (!user) return null;
    const room = [...this.rooms.values()].find((r) => !r.ended && r.participants.has(id));
    return {
      user,
      followers: this.followerIds(id).map((x) => this.publicUser(x)!).filter(Boolean),
      following: this.followingIds(id).map((x) => this.publicUser(x)!).filter(Boolean),
      currentRoom: room ? { id: room.id, title: room.title } : null,
    };
  }

  setFollow(followerId: string, targetId: string, follow: boolean) {
    if (followerId === targetId || !this.users.has(targetId)) return false;
    let set = this.follows.get(followerId);
    if (!set) this.follows.set(followerId, (set = new Set()));
    if (follow) set.add(targetId);
    else set.delete(targetId);
    this.scheduleSave();
    return true;
  }

  listUsers(): PublicUser[] {
    const humans = [...this.users.values()].filter((u) => !u.isBot);
    const notable = DEMO_SEED ? NOTABLE_USERS.map((u) => this.users.get(u.id)).filter((u): u is UserRecord => !!u) : [];
    return [...humans, ...notable].map((u) => this.publicUser(u.id)!);
  }

  // ---------- rooms ----------

  private addBot(room: RoomRecord, userId: string, role: Participant["role"]) {
    room.participants.set(userId, {
      userId,
      role,
      muted: role === "listener" ? true : Math.random() < 0.25,
      handRaised: false,
      handRaisedAt: null,
      speaking: false,
      joinedAt: Date.now() - Math.floor(Math.random() * 600_000),
      socketId: null,
    });
  }

  private isBot(userId: string) {
    return this.users.get(userId)?.isBot ?? false;
  }

  private humansPresent(room: RoomRecord) {
    return [...room.participants.values()].filter((p) => !this.isBot(p.userId));
  }

  private botsInUse() {
    const set = new Set<string>();
    for (const r of this.rooms.values()) if (!r.ended) for (const id of r.participants.keys()) set.add(id);
    return set;
  }

  roomState(roomId: string): RoomState | null {
    const r = this.rooms.get(roomId);
    if (!r) return null;
    return {
      id: r.id,
      title: r.title,
      topic: r.topic,
      description: r.description,
      hostId: r.hostId,
      createdAt: r.createdAt,
      ended: r.ended,
      seeded: r.seeded,
      podiumUserId: r.podiumUserId && r.participants.has(r.podiumUserId) ? r.podiumUserId : null,
      participants: [...r.participants.values()].map((p) => {
        const u = this.users.get(p.userId);
        return {
          userId: p.userId,
          name: u?.name ?? "Unknown",
          color: u?.color ?? "#64748B",
          photoUrl: u ? this.photoUrl(u) : null,
          role: p.role,
          muted: p.muted,
          handRaised: p.handRaised,
          handRaisedAt: p.handRaisedAt,
          speaking: p.speaking && !p.muted,
          isBot: u?.isBot ?? false,
          joinedAt: p.joinedAt,
          away: !u?.isBot && p.socketId === null,
          presence: u?.isBot ? "online" : p.socketId === null || this.hiddenSockets.has(p.socketId) ? "away" : "online",
        };
      }),
    };
  }

  listRooms(): RoomSummary[] {
    return [...this.rooms.values()]
      .filter((r) => !r.ended)
      .map((r) => {
        const parts = [...r.participants.values()];
        const speakers = parts
          .filter((p) => p.role !== "listener")
          .sort((a, b) => (a.role === "host" ? -1 : b.role === "host" ? 1 : a.joinedAt - b.joinedAt));
        return {
          id: r.id,
          title: r.title,
          topic: r.topic,
          description: r.description,
          hostId: r.hostId,
          hostName: this.users.get(r.hostId)?.name ?? "",
          createdAt: r.createdAt,
          seeded: r.seeded,
          speakerCount: speakers.length,
          listenerCount: parts.length - speakers.length,
          speakers: speakers.slice(0, 4).map((p) => {
            const u = this.users.get(p.userId)!;
            return { id: u.id, name: u.name, color: u.color, photoUrl: this.photoUrl(u) };
          }),
        };
      })
      .sort((a, b) => {
        // user-created rooms first, then busiest
        if (a.seeded !== b.seeded) return a.seeded ? 1 : -1;
        return b.speakerCount + b.listenerCount - (a.speakerCount + a.listenerCount);
      });
  }

  createRoom(hostId: string, input: { title?: string; topic?: string; description?: string }) {
    const topic = TOPICS.includes(input.topic as never) ? (input.topic as string) : "Other";
    // Clubhouse-style: title is optional — always create a room on "Let's go".
    const title = clamp(input.title, 80) || (topic !== "Other" ? `${topic} room` : "Open Lounge");
    const room: RoomRecord = {
      id: randomUUID().slice(0, 8),
      title,
      topic,
      description: clamp(input.description, 300),
      hostId,
      createdAt: Date.now(),
      seeded: false,
      ended: false,
      endedAt: null,
      emptySince: Date.now(),
      podiumUserId: hostId,
      participants: new Map(),
      chat: [],
    };
    this.rooms.set(room.id, room);
    this.scheduleSave();
    if (DEMO_SEED) this.scheduleBotAudience(room.id);
    this.events?.roomsListChanged();
    return { ok: true as const, roomId: room.id };
  }

  /** A simulated audience trickles into new rooms so solo testers can try host controls. */
  private scheduleBotAudience(roomId: string) {
    const delays = [2500, 5000, 8000, 12000, 18000];
    delays.forEach((d, i) =>
      setTimeout(() => {
        const room = this.rooms.get(roomId);
        if (!room || room.ended) return;
        const inUse = this.botsInUse();
        const pool = [...this.users.values()].filter((u) => u.isBot && !inUse.has(u.id)).map((u) => u.id);
        const botId = rand(pool);
        if (!botId) return;
        this.addBot(room, botId, "listener");
        const p = room.participants.get(botId)!;
        p.joinedAt = Date.now();
        const bu = this.users.get(botId);
        this.events?.roomPresence({
          roomId,
          type: "join",
          userId: botId,
          name: bu?.name ?? "Someone",
          color: bu?.color ?? "#64748B",
          photoUrl: bu ? this.photoUrl(bu) : null,
          at: Date.now(),
        });
        if (i === 2 || i === 4) {
          // a couple of them want to talk
          setTimeout(() => {
            const pp = this.rooms.get(roomId)?.participants.get(botId);
            if (pp && pp.role === "listener") {
              pp.handRaised = true;
              pp.handRaisedAt = Date.now();
              this.events?.roomChanged(roomId);
              const r = this.rooms.get(roomId);
              const host = r?.hostId;
              if (host && r?.participants.get(host)?.socketId) this.events?.toast(host, `✋ ${this.users.get(botId)?.name} raised their hand`);
            }
          }, 3000);
        }
        this.events?.roomChanged(roomId);
        this.events?.roomsListChanged();
      }, d),
    );
  }

  join(roomId: string, userId: string, socketId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false as const, error: "Room not found" };
    if (room.ended) return { ok: false as const, error: "This room has ended" };

    // one seat per user: leave any other room first
    for (const other of this.rooms.values()) {
      if (other.id !== roomId && other.participants.has(userId)) this.leave(other.id, userId);
    }

    const timerKey = `${roomId}:${userId}`;
    clearTimeout(this.awayTimers.get(timerKey));
    this.awayTimers.delete(timerKey);

    let p = room.participants.get(userId);
    if (p) {
      if (p.socketId && p.socketId !== socketId) this.events?.kickSocket(p.socketId, roomId, "You joined this room from another tab");
      p.socketId = socketId;
    } else {
      const hostPresent = room.participants.has(room.hostId);
      const becomesHost = room.hostId === userId || !hostPresent;
      if (becomesHost) {
        room.hostId = userId;
        room.podiumUserId = userId;
      }
      p = {
        userId,
        role: becomesHost ? "host" : "listener",
        muted: true,
        handRaised: false,
        handRaisedAt: null,
        speaking: false,
        joinedAt: Date.now(),
        socketId,
      };
      room.participants.set(userId, p);
      const u = this.users.get(userId);
      this.events?.roomPresence({
        roomId,
        type: "join",
        userId,
        name: u?.name ?? "Someone",
        color: u?.color ?? "#64748B",
        photoUrl: u ? this.photoUrl(u) : null,
        at: Date.now(),
      });
    }
    room.emptySince = null;
    this.events?.roomChanged(roomId);
    this.events?.roomsListChanged();
    return { ok: true as const };
  }

  /** Foreground/background report for a connection; re-broadcasts the room it's seated in when the dot changes. */
  setSocketVisible(socketId: string, visible: boolean) {
    const was = !this.hiddenSockets.has(socketId);
    if (visible) this.hiddenSockets.delete(socketId);
    else this.hiddenSockets.add(socketId);
    if (was === visible) return;
    const where = this.roomOfSocket(socketId);
    if (where) this.events?.roomChanged(where.roomId);
  }

  /** Connection closed: forget its visibility state. */
  forgetSocket(socketId: string) {
    this.hiddenSockets.delete(socketId);
  }

  /** Socket dropped: keep the seat for a short grace period (handles page refreshes). */
  markAway(roomId: string, userId: string, socketId: string) {
    const room = this.rooms.get(roomId);
    const p = room?.participants.get(userId);
    if (!room || !p || p.socketId !== socketId) return;
    p.socketId = null;
    p.speaking = false;
    const key = `${roomId}:${userId}`;
    clearTimeout(this.awayTimers.get(key));
    this.awayTimers.set(
      key,
      setTimeout(() => {
        this.awayTimers.delete(key);
        const pp = this.rooms.get(roomId)?.participants.get(userId);
        if (pp && pp.socketId === null) this.leave(roomId, userId);
      }, AWAY_GRACE_MS),
    );
    this.events?.roomChanged(roomId);
  }

  leave(roomId: string, userId: string) {
    const room = this.rooms.get(roomId);
    if (!room || !room.participants.has(userId)) return;
    const leaving = room.participants.get(userId)!;
    const uLeft = this.users.get(userId);
    room.participants.delete(userId);
    clearTimeout(this.awayTimers.get(`${roomId}:${userId}`));
    if (room.podiumUserId === userId) room.podiumUserId = null;

    if (leaving.role === "host" && !room.ended) {
      // pass host to the longest-standing human speaker, else any human
      const humans = this.humansPresent(room).sort((a, b) => {
        const rank = (p: ParticipantRecord) => (p.role === "speaker" ? 0 : 1);
        return rank(a) - rank(b) || a.joinedAt - b.joinedAt;
      });
      const next = humans[0];
      if (next) {
        next.role = "host";
        next.handRaised = false;
        room.hostId = next.userId;
        if (!room.podiumUserId) room.podiumUserId = next.userId;
        this.events?.toast(next.userId, "👑 You're now the host of this room");
      }
    }
    this.events?.roomPresence({
      roomId,
      type: "leave",
      userId,
      name: uLeft?.name ?? "Someone",
      color: uLeft?.color ?? "#64748B",
      photoUrl: uLeft ? this.photoUrl(uLeft) : null,
      at: Date.now(),
    });
    if (this.humansPresent(room).length === 0 && !room.seeded) room.emptySince = Date.now();
    this.events?.roomChanged(roomId);
    this.events?.roomsListChanged();
  }

  endRoom(roomId: string, byUserId: string) {
    const room = this.rooms.get(roomId);
    if (!room || room.ended) return { ok: false as const, error: "Room not found" };
    if (room.hostId !== byUserId) return { ok: false as const, error: "Only the host can end the room" };
    this.finish(room);
    return { ok: true as const };
  }

  private finish(room: RoomRecord) {
    room.ended = true;
    room.endedAt = Date.now();
    room.participants.clear();
    room.chat = []; // room chat lives only as long as the room
    this.events?.roomEnded(room.id);
    this.events?.roomsListChanged();
    this.scheduleSave();
  }

  // ---------- in-room actions ----------

  private participant(roomId: string, userId: string) {
    const room = this.rooms.get(roomId);
    const p = room?.participants.get(userId);
    return room && p && !room.ended ? { room, p } : null;
  }

  setHand(roomId: string, userId: string, raised: boolean) {
    const ctx = this.participant(roomId, userId);
    if (!ctx || ctx.p.role !== "listener") return;
    ctx.p.handRaised = raised;
    ctx.p.handRaisedAt = raised ? Date.now() : null;
    if (raised && !this.isBot(ctx.room.hostId) && ctx.room.participants.get(ctx.room.hostId)?.socketId) {
      this.events?.toast(ctx.room.hostId, `✋ ${this.users.get(userId)?.name} raised their hand`);
    }
    this.events?.roomChanged(roomId);
  }

  setMuted(roomId: string, userId: string, muted: boolean) {
    const ctx = this.participant(roomId, userId);
    if (!ctx || ctx.p.role === "listener") return;
    ctx.p.muted = muted;
    if (muted) ctx.p.speaking = false;
    this.events?.roomChanged(roomId);
  }

  setSpeaking(roomId: string, userId: string, speaking: boolean) {
    const ctx = this.participant(roomId, userId);
    if (!ctx || ctx.p.role === "listener" || ctx.p.speaking === speaking) return;
    ctx.p.speaking = speaking && !ctx.p.muted;
    this.events?.roomChanged(roomId);
  }

  moveToAudience(roomId: string, actorId: string, targetId: string) {
    const ctx = this.participant(roomId, targetId);
    if (!ctx) return { ok: false as const, error: "Not in room" };
    const isHost = ctx.room.hostId === actorId;
    if (actorId !== targetId && !isHost) return { ok: false as const, error: "Only the host can do that" };
    if (ctx.p.role !== "speaker") return { ok: false as const, error: "Not a speaker" };
    ctx.p.role = "listener";
    ctx.p.muted = true;
    ctx.p.speaking = false;
    if (actorId !== targetId) this.events?.toast(targetId, "The host moved you to the audience");
    this.events?.roomChanged(roomId);
    this.events?.roomsListChanged();
    return { ok: true as const };
  }

  inviteToSpeak(roomId: string, actorId: string, targetId: string) {
    const ctx = this.participant(roomId, targetId);
    if (!ctx) return { ok: false as const, error: "Not in room" };
    if (ctx.room.hostId !== actorId) return { ok: false as const, error: "Only the host can invite speakers" };
    if (ctx.p.role !== "listener") return { ok: false as const, error: "Already on stage" };
    ctx.p.role = "speaker";
    ctx.p.muted = true;
    ctx.p.handRaised = false;
    ctx.p.handRaisedAt = null;
    this.events?.toast(targetId, `🎤 ${this.users.get(actorId)?.name} invited you to speak — tap the mic to unmute`);
    this.events?.roomChanged(roomId);
    this.events?.roomsListChanged();
    return { ok: true as const };
  }

  hostMute(roomId: string, actorId: string, targetId: string) {
    const ctx = this.participant(roomId, targetId);
    if (!ctx) return { ok: false as const, error: "Not in room" };
    if (ctx.room.hostId !== actorId) return { ok: false as const, error: "Only the host can mute others" };
    ctx.p.muted = true;
    ctx.p.speaking = false;
    // Clubhouse rule: moderators can mute, never force-unmute — the speaker can unmute themselves.
    if (actorId !== targetId) this.events?.toast(targetId, "🔇 A moderator muted you — tap the mic to unmute");
    this.events?.roomChanged(roomId);
    return { ok: true as const };
  }


  /** Give speaking priority (podium) to a stage member. Host can assign anyone on stage; speakers can claim for themselves. */
  setPodium(roomId: string, actorId: string, targetId: string | null) {
    const room = this.rooms.get(roomId);
    if (!room || room.ended) return { ok: false as const, error: "Room not found" };
    if (targetId === null) {
      if (room.hostId !== actorId && room.podiumUserId !== actorId) return { ok: false as const, error: "Only the host can clear the podium" };
      room.podiumUserId = null;
      this.events?.roomChanged(roomId);
      return { ok: true as const };
    }
    const target = room.participants.get(targetId);
    if (!target || target.role === "listener") return { ok: false as const, error: "Only speakers can hold the podium" };
    const isHost = room.hostId === actorId;
    if (!isHost && actorId !== targetId) return { ok: false as const, error: "Only the host can assign the podium" };
    const actor = room.participants.get(actorId);
    if (!actor || (actor.role === "listener" && !isHost)) return { ok: false as const, error: "Join the stage first" };
    room.podiumUserId = targetId;
    this.events?.roomChanged(roomId);
    return { ok: true as const };
  }

  sendReaction(roomId: string, userId: string, emoji: string) {
    const room = this.rooms.get(roomId);
    if (!room || room.ended) return { ok: false as const, error: "Room not found" };
    if (!room.participants.has(userId)) return { ok: false as const, error: "Join the room first" };
    const e = String(emoji ?? "").trim();
    if (!(ROOM_REACTIONS as readonly string[]).includes(e)) return { ok: false as const, error: "Unknown reaction" };
    const now = Date.now();
    const recent = (this.reactionRate.get(userId) ?? []).filter((t) => now - t < 3_000);
    if (recent.length >= 8) return { ok: false as const, error: "Slow down on reactions" };
    this.reactionRate.set(userId, [...recent, now]);
    const u = this.users.get(userId);
    if (!u) return { ok: false as const, error: "User not found" };
    const reaction: RoomReaction = {
      id: randomUUID().slice(0, 10),
      roomId,
      userId,
      name: u.name,
      color: u.color,
      photoUrl: this.photoUrl(u),
      emoji: e,
      createdAt: now,
    };
    this.events?.roomReaction(reaction);
    return { ok: true as const, reaction };
  }

  roleOf(roomId: string, userId: string) {
    const room = this.rooms.get(roomId);
    return room && !room.ended ? (room.participants.get(userId)?.role ?? null) : null;
  }

  /** Connection id of a (connected) participant. */
  socketOf(roomId: string, userId: string) {
    return this.rooms.get(roomId)?.participants.get(userId)?.socketId ?? null;
  }

  roomOfSocket(socketId: string): { roomId: string; userId: string } | null {
    for (const r of this.rooms.values())
      for (const p of r.participants.values()) if (p.socketId === socketId) return { roomId: r.id, userId: p.userId };
    return null;
  }

  // ---------- room chat ----------

  private pushChat(room: RoomRecord, authorId: string, text: string, createdAt = Date.now()): ChatMessage | null {
    const u = this.users.get(authorId);
    const p = room.participants.get(authorId);
    if (!u || !p) return null;
    const msg: ChatMessage = {
      id: randomUUID(),
      roomId: room.id,
      authorId,
      authorName: u.name,
      authorColor: u.color,
      authorPhotoUrl: this.photoUrl(u),
      authorRole: p.role,
      authorIsBot: u.isBot,
      text,
      createdAt,
    };
    room.chat.push(msg);
    if (room.chat.length > ROOM_CHAT_HISTORY) room.chat.splice(0, room.chat.length - ROOM_CHAT_HISTORY);
    return msg;
  }

  chatHistory(roomId: string): ChatMessage[] {
    return [...(this.rooms.get(roomId)?.chat ?? [])];
  }

  /** Simple per-user rate limit shared by room chat and DMs: 8 messages / 10 s. */
  private rateLimited(userId: string) {
    const now = Date.now();
    const recent = (this.chatRate.get(userId) ?? []).filter((t) => now - t < 10_000);
    if (recent.length >= 8) {
      this.chatRate.set(userId, recent);
      return true;
    }
    recent.push(now);
    this.chatRate.set(userId, recent);
    return false;
  }

  sendChat(roomId: string, userId: string, rawText: unknown) {
    const ctx = this.participant(roomId, userId);
    if (!ctx) return { ok: false as const, error: "Join the room to chat" };
    const text = clamp(rawText, CHAT_MAX_LENGTH);
    if (!text) return { ok: false as const, error: "Message is empty" };
    if (this.rateLimited(userId)) return { ok: false as const, error: "Slow down a little 🙂" };
    const firstMessage = !ctx.room.chat.some((m) => m.authorId === userId);
    const msg = this.pushChat(ctx.room, userId, text)!;
    this.events?.chatMessage(msg);

    // demo flavour: someone in a seeded room waves at newcomers
    if (DEMO_SEED && firstMessage && ctx.room.seeded && Math.random() < 0.7) {
      setTimeout(() => {
        const room = this.rooms.get(roomId);
        if (!room || room.ended) return;
        const bot = rand([...room.participants.values()].filter((p) => this.isBot(p.userId)));
        const name = this.users.get(userId)?.name.split(" ")[0] ?? "friend";
        const reply = bot && this.pushChat(room, bot.userId, rand([`Welcome ${name}! 👋`, `hey ${name} 🙌`, `${name}! good to see you here`])!);
        if (reply) this.events?.chatMessage(reply);
      }, 1800 + Math.random() * 2000);
    }
    return { ok: true as const, message: msg };
  }

  deleteChat(roomId: string, userId: string, messageId: string) {
    const room = this.rooms.get(roomId);
    if (!room || room.ended) return { ok: false as const, error: "Room not found" };
    const idx = room.chat.findIndex((m) => m.id === messageId);
    if (idx === -1) return { ok: false as const, error: "Message not found" };
    if (room.chat[idx].authorId !== userId && room.hostId !== userId)
      return { ok: false as const, error: "Only the host or the author can delete a message" };
    room.chat.splice(idx, 1);
    this.events?.chatDeleted(roomId, messageId);
    return { ok: true as const };
  }

  // ---------- direct messages ----------

  private lastRead(userId: string, peerId: string) {
    return this.dmReads.get(userId)?.get(peerId) ?? 0;
  }

  /**
   * `userId` has seen the conversation with `peerId` up to `upToMessageId` (default: everything). Moves the
   * unread pointer and stamps readAt on every message from peerId up to there that wasn't seen yet. Returns
   * whether the unread pointer moved, and the read receipt to push to the sender (null if nothing new was seen).
   */
  markDmRead(userId: string, peerId: string, upToMessageId?: unknown): { changed: boolean; receipt: DmReadReceipt | null } {
    let reads = this.dmReads.get(userId);
    if (!reads) this.dmReads.set(userId, (reads = new Map()));
    const list = this.dms.get(conversationId(userId, peerId)) ?? [];
    let target = list.length - 1;
    if (typeof upToMessageId === "string" && upToMessageId) {
      // unknown / foreign id (stale client, other thread) → nothing is stamped: receipts never run ahead of what was shown
      target = list.findIndex((m) => m.id === upToMessageId);
      if (target < 0) return { changed: false, receipt: null };
    }
    const now = Date.now();
    let receipt: DmReadReceipt | null = null;
    for (let i = 0; i <= target; i++) {
      const m = list[i];
      if (m.fromId !== peerId || m.toId !== userId || m.readAt) continue;
      m.readAt = now;
      receipt = { peerId, readerId: userId, upToMessageId: m.id, readAt: now };
    }
    const cursor = target >= 0 ? list[target].createdAt : now;
    const changed = (reads.get(peerId) ?? 0) < cursor;
    if (changed) reads.set(peerId, cursor);
    if (changed || receipt) this.scheduleSave();
    if (receipt) this.events?.dmRead?.(receipt);
    return { changed, receipt };
  }

  unreadDmCount(userId: string) {
    return this.conversations(userId).reduce((n, c) => n + c.unread, 0);
  }

  conversations(userId: string): ConversationSummary[] {
    const out: ConversationSummary[] = [];
    for (const [key, list] of this.dms) {
      if (!list.length) continue;
      const [a, b] = key.split("|");
      if (a !== userId && b !== userId) continue;
      const peerId = a === userId ? b : a;
      const peer = this.publicUser(peerId);
      if (!peer) continue;
      const read = this.lastRead(userId, peerId);
      const unread = list.filter((m) => m.toId === userId && m.createdAt > read).length;
      out.push({ peer, lastMessage: list[list.length - 1], unread });
    }
    return out.sort((x, y) => y.lastMessage.createdAt - x.lastMessage.createdAt);
  }

  dmHistory(userId: string, peerId: string, before?: number, limit = 60) {
    const list = this.dms.get(conversationId(userId, peerId)) ?? [];
    const older = before ? list.filter((m) => m.createdAt < before) : list;
    return { messages: older.slice(-limit), hasMore: older.length > limit };
  }

  /** All DMs to/from userId at or after `after` (inclusive; clients dedupe by id), oldest first — reconnect catch-up. */
  dmsSince(userId: string, after: number, limit = 200) {
    const out: DirectMessage[] = [];
    for (const [key, list] of this.dms) {
      const [a, b] = key.split("|");
      if (a !== userId && b !== userId) continue;
      for (let i = list.length - 1; i >= 0 && list[i].createdAt >= after; i--) out.push(list[i]);
    }
    out.sort((x, y) => x.createdAt - y.createdAt);
    return { messages: out.slice(-limit), hasMore: out.length > limit };
  }

  sendDm(fromId: string, toId: string, rawText: unknown, clientId?: unknown) {
    if (fromId === toId) return { ok: false as const, error: "You can't message yourself" };
    if (!this.users.has(toId)) return { ok: false as const, error: "User not found" };
    const text = clamp(rawText, CHAT_MAX_LENGTH);
    if (!text) return { ok: false as const, error: "Message is empty" };
    const cid = typeof clientId === "string" && /^[\w-]{1,64}$/.test(clientId) ? clientId : undefined;
    if (cid) {
      // retried send (ack lost on a dropped connection): return the stored message instead of a duplicate
      const recent = this.dms.get(conversationId(fromId, toId)) ?? [];
      for (let i = recent.length - 1; i >= Math.max(0, recent.length - 50); i--)
        if (recent[i].clientId === cid && recent[i].fromId === fromId) return { ok: true as const, message: recent[i] };
    }
    if (this.rateLimited(fromId)) return { ok: false as const, error: "Slow down a little 🙂" };
    const msg = this.appendDm(fromId, toId, text, cid);
    // sending implies you've read everything before it
    this.markDmRead(fromId, toId);
    if (DEMO_SEED && this.isBot(toId)) this.scheduleBotDmReply(toId, fromId);
    return { ok: true as const, message: msg };
  }

  private appendDm(fromId: string, toId: string, text: string, clientId?: string) {
    const key = conversationId(fromId, toId);
    const list = this.dms.get(key) ?? [];
    const from = this.users.get(fromId);
    const msg: DirectMessage = {
      id: randomUUID(),
      fromId,
      fromName: from?.name ?? "Someone",
      fromColor: from?.color ?? "#64748B",
      toId,
      text,
      // server clock is the source of truth; strictly increasing per conversation so (createdAt, id) order ==
      // send order even if the host clock steps backwards (NTP) or two sends land in the same millisecond
      createdAt: Math.max(Date.now(), (list[list.length - 1]?.createdAt ?? 0) + 1),
      readAt: null,
      ...(clientId ? { clientId } : {}),
    };
    list.push(msg);
    if (list.length > DM_HISTORY_PER_CONVERSATION) list.splice(0, list.length - DM_HISTORY_PER_CONVERSATION);
    this.dms.set(key, list);
    this.scheduleSave();
    this.events?.dmMessage(msg);
    return msg;
  }

  private botReplyPending = new Set<string>();

  /** Demo bots answer DMs (with a typing indicator) so solo testers get a conversation. */
  private scheduleBotDmReply(botId: string, humanId: string) {
    const key = conversationId(botId, humanId);
    if (this.botReplyPending.has(key)) return;
    this.botReplyPending.add(key);
    const typingAt = 700 + Math.random() * 900;
    const replyAt = typingAt + 1400 + Math.random() * 1600;
    setTimeout(() => this.events?.dmTyping(botId, humanId), typingAt);
    setTimeout(() => this.events?.dmTyping(botId, humanId), typingAt + 1200);
    setTimeout(() => {
      this.botReplyPending.delete(key);
      const human = this.users.get(humanId);
      const first = human?.name.split(" ")[0] ?? "there";
      const history = this.dms.get(key) ?? [];
      const botMessages = history.filter((m) => m.fromId === botId).length;
      const room = [...this.rooms.values()].find((r) => !r.ended && r.participants.has(botId));
      let text: string;
      if (botMessages === 0) text = `Hey ${first}! 👋 Thanks for reaching out.`;
      else if (room && Math.random() < 0.3) text = `I'm in “${room.title}” right now — come hang out!`;
      else text = rand(BOT_DM_REPLIES)!.replace("{name}", first);
      this.appendDm(botId, humanId, text);
    }, replyAt);
  }

  // ---------- simulation tick (bots) ----------

  private tick() {
    const now = Date.now();
    let listChanged = false;
    for (const room of this.rooms.values()) {
      if (room.ended) {
        if (room.endedAt && now - room.endedAt > 30 * 60_000) this.rooms.delete(room.id);
        continue;
      }
      if (!room.seeded && room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL_MS) {
        this.finish(room);
        continue;
      }
      let changed = false;
      const parts = [...room.participants.values()];
      const bots = parts.filter((p) => this.isBot(p.userId));
      const humanSpeaking = parts.some((p) => !this.isBot(p.userId) && p.speaking);
      const botSpeakers = bots.filter((p) => p.role !== "listener");

      // 1) simulated speaking: usually one bot talks at a time
      const talker = !humanSpeaking && Math.random() < 0.8 ? rand(botSpeakers.filter((p) => !p.muted)) : undefined;
      for (const b of botSpeakers) {
        const next = b === talker;
        if (b.speaking !== next) {
          b.speaking = next;
          changed = true;
        }
      }
      if (talker && room.podiumUserId !== talker.userId) {
        room.podiumUserId = talker.userId;
        changed = true;
      }
      // occasionally bots toggle their own mic
      if (Math.random() < 0.04) {
        const b = rand(botSpeakers.filter((p) => p.role === "speaker"));
        if (b) {
          b.muted = !b.muted;
          changed = true;
        }
      }

      const hostIsBot = this.isBot(room.hostId);
      if (hostIsBot) {
        // 2) bot hosts accept raised hands after a few seconds
        for (const p of parts) {
          if (!p.handRaised || !p.handRaisedAt) continue;
          const human = !this.isBot(p.userId);
          const wait = human ? 4000 : 7000;
          if (now - p.handRaisedAt > wait && (human || botSpeakers.length < MAX_BOT_SPEAKERS)) {
            this.inviteToSpeak(room.id, room.hostId, p.userId);
            changed = true;
            listChanged = true;
          }
        }
        // 3) random bot listener raises hand; random bot speaker steps down
        if (Math.random() < 0.015 && !bots.some((b) => b.handRaised)) {
          const b = rand(bots.filter((p) => p.role === "listener"));
          if (b) {
            b.handRaised = true;
            b.handRaisedAt = now;
            changed = true;
          }
        }
        if (Math.random() < 0.01 && botSpeakers.length > 2) {
          const b = rand(botSpeakers.filter((p) => p.role === "speaker"));
          if (b) {
            b.role = "listener";
            b.muted = true;
            b.speaking = false;
            changed = true;
            listChanged = true;
          }
        }
      }

      // 4) listener churn in seeded rooms keeps counts feeling live
      if (room.seeded && Math.random() < 0.05) {
        const listeners = bots.filter((p) => p.role === "listener" && !p.handRaised);
        if (Math.random() < 0.5 && listeners.length > 5) {
          const b = rand(listeners)!;
          room.participants.delete(b.userId);
        } else if (listeners.length < 30) {
          const inUse = this.botsInUse();
          const id = rand([...this.users.values()].filter((u) => u.isBot && !inUse.has(u.id)).map((u) => u.id));
          if (id) {
            this.addBot(room, id, "listener");
            room.participants.get(id)!.joinedAt = now;
          }
        }
        changed = true;
        listChanged = true;
      }

      // 5) occasional audience chatter in seeded rooms
      if (room.seeded && Math.random() < 0.025 && bots.length) {
        const b = rand(bots)!;
        const msg = this.pushChat(room, b.userId, rand(BOT_CHAT_LINES)!);
        if (msg) this.events?.chatMessage(msg);
      }

      if (changed) this.events?.roomChanged(room.id);
    }
    if (listChanged) this.events?.roomsListChanged();
  }
}

export const store = new Store();
