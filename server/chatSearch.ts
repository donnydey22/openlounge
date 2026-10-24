// Chat + global search for the /hx/* route handlers (#hashtags, @mentions, keywords; in one chat or across mine).
// Postgres: the trigger-maintained index from migration 020 (message_hashtags / message_mentions / room_hashtags /
// user_hashtags, FTS + trigram on dms.text). Without DATABASE_URL (local dev) the same rules run over DATA_DIR/db.json.
//
// Privacy (enforced here, never on the client):
//  - Messages only from conversations the caller is in: 1:1 rows where they are sender/recipient, group rows where
//    they are a current member of a non-deleted group.
//  - Removed rows (unsend, moderator removal, trim, expiry) leave `dms` → gone from results; deleted accounts are
//    hidden (and their 1:1 chats); blocked people (either direction) are hidden from people/mention cards and their
//    messages are dropped.
//  - Rooms: only the `rooms` table, which only ever holds open public rooms (private/drop-in rooms are never stored).
// Every message hit is re-checked with the app tokenizer, so results always match what the user sees highlighted.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { extractHashtags, extractMentions } from "../src/lib/linkify";
import { matchesWords, type ParsedQuery } from "../src/lib/searchQuery";

export type HxMessage = {
  id: string;
  /** where to jump: /messages/<peer or group id>?m=<message id> */
  href: string;
  chat: { id: string; kind: "dm" | "group"; title: string; color: string; photoUrl: string | null };
  from: { id: string; name: string; me: boolean };
  text: string;
  at: number;
};
export type HxRoom = { id: string; title: string; description: string; topic: string; hostId: string; live: true };
export type HxPerson = { id: string; name: string; username: string; color: string; photoUrl: string | null; bio: string; following?: boolean };
export type HxSuggestion = { tag: string; count: number; last: number };
export type HxMember = { id: string; name: string; username: string; color: string; photoUrl: string | null };
export type Cursor = { at: number; id: string } | null;

const MAX_TEXT = 280;
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
const photoUrl = (id: string, v: unknown) => (v ? `/avatars/${id}?v=${v}` : null);
const likeEsc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const pair = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function verifyText(text: string, q: ParsedQuery) {
  if (q.tags.length) {
    const t = extractHashtags(text);
    if (!q.tags.every((x) => t.includes(x))) return false;
  }
  if (q.words.length && !matchesWords(text, q.words)) return false;
  return true;
}

// ---------- Postgres ----------
type G = { __olHxPool?: pg.Pool; __olHxCaps?: Promise<{ groups: boolean }> };
const g = globalThis as unknown as G;

function chooseSsl(url: string): { connectionString: string; ssl: pg.PoolConfig["ssl"] } {
  // mirrors server/pg.ts chooseSsl (kept local so the Next bundle doesn't import the persistence layer)
  let host = "";
  let mode = (process.env.DATABASE_SSL || "").toLowerCase();
  let connectionString = url;
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    mode ||= (u.searchParams.get("sslmode") || "").toLowerCase();
    u.searchParams.delete("sslmode");
    u.searchParams.delete("uselibpqcompat");
    connectionString = u.toString();
  } catch {
    /* keep */
  }
  if (["disable", "off", "false", "0", "allow"].includes(mode)) return { connectionString, ssl: false };
  if (["require", "prefer", "true", "1", "no-verify", "on"].includes(mode)) return { connectionString, ssl: { rejectUnauthorized: false } };
  if (["verify", "verify-ca", "verify-full"].includes(mode)) return { connectionString, ssl: { rejectUnauthorized: true } };
  if (host.endsWith(".railway.internal")) return { connectionString, ssl: false };
  if (host.endsWith(".rlwy.net") || host.endsWith(".railway.app")) return { connectionString, ssl: { rejectUnauthorized: false } };
  return { connectionString, ssl: undefined };
}

function pool(): pg.Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!g.__olHxPool) {
    const p = new pg.Pool({ ...chooseSsl(url), max: 3, idleTimeoutMillis: 30_000, statement_timeout: 4000, application_name: "openlounge-search" });
    p.on("error", () => {});
    g.__olHxPool = p;
  }
  return g.__olHxPool;
}

function caps(p: pg.Pool) {
  return (g.__olHxCaps ??= p
    .query<{ groups: boolean }>("SELECT to_regclass('conversation_members') IS NOT NULL AND to_regclass('conversations') IS NOT NULL AS groups")
    .then((r) => ({ groups: !!r.rows[0]?.groups }))
    .catch(() => {
      g.__olHxCaps = undefined;
      return { groups: false };
    }));
}

const BLOCKED = (u: string) => `(SELECT blocked_id FROM user_blocks WHERE blocker_id = ${u} UNION SELECT blocker_id FROM user_blocks WHERE blocked_id = ${u})`;

/** builds the shared WHERE for message search; returns sql + params (params[0] = me) */
function messageWhere(me: string, q: ParsedQuery, o: { chat: string | null; from: string | null; mentionIds: string[]; groups: boolean; before: Cursor }) {
  const params: unknown[] = [me];
  const P = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const w: string[] = ["d.kind IS NULL"];
  const member = o.groups
    ? `((strpos(d.conversation_id, '|') > 0 AND (d.from_id = $1 OR d.to_id = $1)) OR (strpos(d.conversation_id, '|') = 0 AND EXISTS (
         SELECT 1 FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
         WHERE cm.conversation_id = d.conversation_id AND cm.user_id = $1 AND c.deleted_at IS NULL)))`
    : `(strpos(d.conversation_id, '|') > 0 AND (d.from_id = $1 OR d.to_id = $1))`;
  w.push(member);
  // chat = a peer user id (1:1) or a group id; membership above still decides what is visible
  if (o.chat) w.push(`d.conversation_id = ANY(${P([o.chat, pair(me, o.chat)])}::text[])`);
  if (o.from) w.push(`d.from_id = ${P(o.from)}`);
  for (const t of q.tags) w.push(`EXISTS (SELECT 1 FROM message_hashtags h WHERE h.message_id = d.id AND h.tag = ${P(t)})`);
  q.mentions.forEach((h, i) => {
    const uid = o.mentionIds[i];
    w.push(`EXISTS (SELECT 1 FROM message_mentions mm WHERE mm.message_id = d.id AND (mm.handle = ${P(h)}${uid ? ` OR mm.user_id = ${P(uid)}` : ""}))`);
  });
  if (q.words.length) {
    // prefix full-text (GIN) OR partial word (trigram/ILIKE); words are letters/digits only (see parseSearchQuery)
    const tsq = q.words.map((x) => `${x.replace(/[^\p{L}\p{N}_]/gu, "")}:*`).filter((x) => x.length > 2).join(" & ");
    const likes = q.words.map((x) => `d.text ILIKE ${P(`%${likeEsc(x)}%`)}`).join(" AND ");
    w.push(tsq ? `(to_tsvector('simple', d.text) @@ to_tsquery('simple', ${P(tsq)}) OR (${likes}))` : `(${likes})`);
  }
  if (o.before) w.push(`(d.created_at, d.id) < (${P(o.before.at)}::bigint, ${P(o.before.id)}::text)`);
  w.push(`NOT EXISTS (SELECT 1 FROM users xu WHERE xu.id = d.from_id AND xu.deleted_at IS NOT NULL)`);
  w.push(`(strpos(d.conversation_id, '|') = 0 OR NOT EXISTS (SELECT 1 FROM users xp WHERE xp.id = (CASE WHEN d.from_id = $1 THEN d.to_id ELSE d.from_id END) AND xp.deleted_at IS NOT NULL))`);
  w.push(`d.from_id NOT IN ${BLOCKED("$1")}`);
  return { where: w.join("\n AND "), params };
}

async function resolveHandles(p: pg.Pool, handles: string[]): Promise<Map<string, string>> {
  if (!handles.length) return new Map();
  const r = await p.query<{ id: string; username: string }>("SELECT id, username FROM users WHERE username = ANY($1::text[]) AND deleted_at IS NULL", [handles]);
  return new Map(r.rows.map((x) => [x.username, x.id]));
}

async function pgMessages(p: pg.Pool, me: string, q: ParsedQuery, o: { chat: string | null; from: string | null; before: Cursor; limit: number }) {
  const { groups } = await caps(p);
  const ids = await resolveHandles(p, q.mentions);
  const mentionIds = q.mentions.map((h) => ids.get(h) ?? "");
  const { where, params } = messageWhere(me, q, { ...o, mentionIds, groups });
  const lim = `$${params.length + 1}`;
  const rows = await p.query(
    `SELECT d.id, d.conversation_id, d.from_id, d.to_id, d.text, d.created_at, fu.name AS from_name,
            pu.id AS peer_id, pu.name AS peer_name, pu.color AS peer_color, pu.photo_version AS peer_photo
            ${groups ? ", gc.title AS group_title, gc.color AS group_color" : ""}
       FROM dms d
       LEFT JOIN users fu ON fu.id = d.from_id
       LEFT JOIN users pu ON strpos(d.conversation_id, '|') > 0 AND pu.id = (CASE WHEN d.from_id = $1 THEN d.to_id ELSE d.from_id END)
       ${groups ? "LEFT JOIN conversations gc ON gc.id = d.conversation_id AND strpos(d.conversation_id, '|') = 0" : ""}
      WHERE ${where}
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT ${lim}`,
    [...params, o.limit + 1],
  );
  // total ("N of M") only on the first page; capped so it stays cheap
  const total = o.before
    ? null
    : Number((await p.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM dms d WHERE ${where} LIMIT 1000) x`, params)).rows[0]?.n ?? 0);
  const out: HxMessage[] = [];
  for (const row of rows.rows.slice(0, o.limit)) {
    const dm = String(row.conversation_id).includes("|");
    if (dm && !row.peer_id) continue;
    if (!verifyText(row.text, q)) continue;
    const chatId = dm ? String(row.peer_id) : String(row.conversation_id);
    out.push({
      id: row.id,
      href: `/messages/${encodeURIComponent(chatId)}?m=${encodeURIComponent(row.id)}`,
      chat: dm
        ? { id: chatId, kind: "dm", title: row.peer_name ?? "", color: row.peer_color ?? "#10B981", photoUrl: photoUrl(row.peer_id, row.peer_photo) }
        : { id: chatId, kind: "group", title: row.group_title || "Group", color: row.group_color ?? "#10B981", photoUrl: null },
      from: { id: row.from_id, name: row.from_name ?? "", me: row.from_id === me },
      text: clip(row.text),
      at: Number(row.created_at),
    });
  }
  const last = rows.rows[Math.min(rows.rows.length, o.limit) - 1];
  const next = rows.rows.length > o.limit && last ? `${last.created_at}:${last.id}` : null;
  return { messages: out, total, next, mentionIds: ids };
}

async function pgRooms(p: pg.Pool, q: ParsedQuery, hostIds: string[]): Promise<HxRoom[]> {
  if (!q.tags.length && !hostIds.length) return [];
  const params: unknown[] = [];
  const w: string[] = [];
  for (const t of q.tags) {
    params.push(t);
    w.push(`EXISTS (SELECT 1 FROM room_hashtags rh WHERE rh.room_id = r.id AND rh.tag = $${params.length})`);
  }
  if (hostIds.length) {
    params.push(hostIds);
    w.push(`r.host_id = ANY($${params.length}::text[])`);
  }
  const r = await p.query(`SELECT r.id, r.title, r.description, r.topic, r.host_id FROM rooms r WHERE ${w.join(" AND ")} ORDER BY r.created_at DESC LIMIT 20`, params);
  return r.rows
    .filter((x) => !q.words.length || matchesWords(`${x.title}\n${x.description}`, q.words))
    .map((x) => ({ id: x.id, title: x.title, description: clip(x.description), topic: x.topic, hostId: x.host_id, live: true as const }));
}

const PERSON_COLS = `u.id, u.name, u.username, u.color, u.photo_version, u.bio,
  EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followee_id = u.id) AS following`;
const toPerson = (x: Record<string, unknown>): HxPerson => ({
  id: String(x.id),
  name: String(x.name),
  username: String(x.username),
  color: String(x.color),
  photoUrl: photoUrl(String(x.id), x.photo_version),
  bio: clip(String(x.bio ?? "")),
  following: !!x.following,
});

async function pgPeopleByTags(p: pg.Pool, me: string, tags: string[]): Promise<HxPerson[]> {
  if (!tags.length) return [];
  const r = await p.query(
    `SELECT ${PERSON_COLS} FROM users u
      WHERE u.deleted_at IS NULL AND u.id NOT IN ${BLOCKED("$1")}
        AND (SELECT count(*) FROM user_hashtags uh WHERE uh.user_id = u.id AND uh.tag = ANY($2::text[])) = cardinality($2::text[])
      ORDER BY (u.id = $1) ASC, u.created_at DESC LIMIT 20`,
    [me, tags],
  );
  return r.rows.map(toPerson);
}

async function pgProfiles(p: pg.Pool, me: string, handles: string[]): Promise<HxPerson[]> {
  if (!handles.length) return [];
  const r = await p.query(`SELECT ${PERSON_COLS} FROM users u WHERE u.username = ANY($2::text[]) AND u.deleted_at IS NULL AND u.id NOT IN ${BLOCKED("$1")}`, [me, handles]);
  return r.rows.map(toPerson);
}

async function pgSuggestTags(p: pg.Pool, me: string, prefix: string, limit: number): Promise<HxSuggestion[]> {
  const { groups } = await caps(p);
  const r = await p.query(
    `WITH mine AS (
       SELECT h.tag, count(*)::int AS n, max(h.created_at)::bigint AS last FROM message_hashtags h
        WHERE h.tag LIKE $2
          AND ((strpos(h.conversation_id, '|') > 0 AND (split_part(h.conversation_id, '|', 1) = $1 OR split_part(h.conversation_id, '|', 2) = $1))
               ${groups ? "OR h.conversation_id IN (SELECT cm.conversation_id FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id WHERE cm.user_id = $1 AND c.deleted_at IS NULL)" : ""})
        GROUP BY h.tag),
     pub AS (
       SELECT tag, count(*)::int AS n, 0::bigint AS last FROM (
         SELECT rh.tag FROM room_hashtags rh WHERE rh.tag LIKE $2
         UNION ALL SELECT uh.tag FROM user_hashtags uh JOIN users u ON u.id = uh.user_id WHERE uh.tag LIKE $2 AND u.deleted_at IS NULL) x
       GROUP BY tag)
     SELECT tag, sum(n)::int AS count, max(last)::bigint AS last FROM (
       SELECT tag, n * 3 AS n, last FROM mine UNION ALL SELECT tag, n, last FROM pub) t
     GROUP BY tag ORDER BY max(last) DESC, sum(n) DESC, tag LIMIT $3`,
    [me, likeEsc(prefix) + "%", limit],
  );
  return r.rows.map((x) => ({ tag: x.tag, count: Number(x.count), last: Number(x.last) }));
}

async function pgSuggestPeople(p: pg.Pool, me: string, prefix: string, limit: number): Promise<HxPerson[]> {
  // people I follow first, then people I already chat with, then everyone else; screen name or display name prefix
  const r = await p.query(
    `SELECT ${PERSON_COLS},
            EXISTS (SELECT 1 FROM dms d WHERE d.conversation_id = (CASE WHEN u.id < $1 THEN u.id || '|' || $1 ELSE $1 || '|' || u.id END)) AS contact
       FROM users u
      WHERE u.deleted_at IS NULL AND u.id <> $1 AND u.id NOT IN ${BLOCKED("$1")}
        AND ($2 = '' OR u.username LIKE $3 OR lower(u.name) LIKE $3 OR lower(u.name) LIKE $4)
      ORDER BY following DESC, contact DESC, (u.username LIKE $3) DESC, u.created_at DESC
      LIMIT $5`,
    [me, prefix, likeEsc(prefix) + "%", "% " + likeEsc(prefix) + "%", limit],
  );
  return r.rows.map(toPerson);
}

async function pgMembers(p: pg.Pool, me: string, chat: string): Promise<HxMember[] | null> {
  const { groups } = await caps(p);
  if (groups) {
    const r = await p.query(
      `SELECT u.id, u.name, u.username, u.color, u.photo_version FROM conversation_members cm
         JOIN conversations c ON c.id = cm.conversation_id AND c.type = 'group' AND c.deleted_at IS NULL
         JOIN users u ON u.id = cm.user_id AND u.deleted_at IS NULL
        WHERE cm.conversation_id = $2 AND EXISTS (SELECT 1 FROM conversation_members me WHERE me.conversation_id = $2 AND me.user_id = $1)
        ORDER BY (u.id = $1) DESC, u.name LIMIT 500`,
      [me, chat],
    );
    if (r.rows.length) return r.rows.map((x) => ({ id: x.id, name: x.name, username: x.username, color: x.color, photoUrl: photoUrl(x.id, x.photo_version) }));
  }
  const r = await p.query(`SELECT id, name, username, color, photo_version FROM users WHERE id = ANY($1::text[]) AND deleted_at IS NULL ORDER BY (id = $2) DESC`, [[me, chat], me]);
  if (!r.rows.some((x) => x.id === chat)) return null;
  return r.rows.map((x) => ({ id: x.id, name: x.name, username: x.username, color: x.color, photoUrl: photoUrl(x.id, x.photo_version) }));
}

// ---------- JSON store fallback (local dev only; 1:1 chats) ----------
type JUser = { id: string; name: string; username: string; color: string; bio?: string; photoVersion?: number; deletedAt?: number; isBot?: boolean; createdAt?: number };
type JDm = { id: string; fromId: string; toId: string; text: string; createdAt: number; kind?: string };
type JRoom = { id: string; title: string; topic: string; description?: string; hostId?: string; createdAt?: number };
type JDb = { users: JUser[]; dms: JDm[]; rooms: JRoom[]; follows?: Record<string, string[]>; blocks?: { blockerId: string; blockedId: string }[] };
let jcache: { mtime: number; db: JDb } | null = null;
function jsonDb(): JDb | null {
  const file = path.join(path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data")), "db.json");
  try {
    const st = fs.statSync(file);
    if (!jcache || jcache.mtime !== st.mtimeMs) jcache = { mtime: st.mtimeMs, db: JSON.parse(fs.readFileSync(file, "utf8")) as JDb };
    return jcache.db;
  } catch {
    return null;
  }
}
function jBlocked(db: JDb, me: string) {
  const s = new Set<string>();
  for (const b of db.blocks ?? []) {
    if (b.blockerId === me) s.add(b.blockedId);
    if (b.blockedId === me) s.add(b.blockerId);
  }
  return s;
}
const jPerson = (db: JDb, me: string, u: JUser): HxPerson => ({
  id: u.id,
  name: u.name,
  username: u.username,
  color: u.color,
  photoUrl: photoUrl(u.id, u.photoVersion),
  bio: clip(u.bio ?? ""),
  following: !!db.follows?.[me]?.includes(u.id),
});

function jMessages(db: JDb, me: string, q: ParsedQuery, o: { chat: string | null; from: string | null; before: Cursor; limit: number }) {
  const users = new Map(db.users.map((u) => [u.id, u]));
  const byHandle = new Map(db.users.filter((u) => !u.deletedAt).map((u) => [u.username, u.id]));
  const blocked = jBlocked(db, me);
  const all: HxMessage[] = [];
  for (const d of [...db.dms].sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))) {
    if (d.kind || (d as { deleted?: boolean }).deleted || (d.fromId !== me && d.toId !== me)) continue;
    const peerId = d.fromId === me ? d.toId : d.fromId;
    if (o.chat && peerId !== o.chat) continue;
    if (o.from && d.fromId !== o.from) continue;
    if (o.before && (d.createdAt > o.before.at || (d.createdAt === o.before.at && d.id >= o.before.id))) continue;
    const peer = users.get(peerId);
    if (!peer || peer.deletedAt || blocked.has(d.fromId)) continue;
    if (!verifyText(d.text, q)) continue;
    if (q.mentions.length) {
      const m = extractMentions(d.text);
      if (!q.mentions.every((h) => m.includes(h) || (byHandle.get(h) && m.some((x) => byHandle.get(x) === byHandle.get(h))))) continue;
    }
    all.push({
      id: d.id,
      href: `/messages/${encodeURIComponent(peerId)}?m=${encodeURIComponent(d.id)}`,
      chat: { id: peerId, kind: "dm", title: peer.name, color: peer.color, photoUrl: photoUrl(peer.id, peer.photoVersion) },
      from: { id: d.fromId, name: users.get(d.fromId)?.name ?? "", me: d.fromId === me },
      text: clip(d.text),
      at: d.createdAt,
    });
    if (all.length > 1000) break;
  }
  const page = all.slice(0, o.limit);
  const last = page.at(-1);
  return { messages: page, total: o.before ? null : all.length, next: all.length > o.limit && last ? `${last.at}:${last.id}` : null };
}

// ---------- public API ----------
export function parseCursor(s: string | null): Cursor {
  const m = (s ?? "").match(/^(\d{1,16}):([\w|.-]{1,100})$/);
  return m ? { at: Number(m[1]), id: m[2] } : null;
}

export type SearchOpts = { scope: "chat" | "messages" | "all"; chat?: string | null; from?: string | null; before?: Cursor; limit?: number };

export async function search(me: string, q: ParsedQuery, o: SearchOpts) {
  const chat = o.scope === "chat" ? (o.chat ?? null) : null;
  const from = o.from ?? null;
  const limit = Math.max(1, Math.min(50, o.limit ?? 30));
  const before = o.before ?? null;
  const withPublic = o.scope === "all" && !before;
  // across chats a query needs a #tag, an @mention, or a real word (no "list everything")
  const canMessages = !!chat || q.tags.length > 0 || q.mentions.length > 0 || q.words.some((w) => w.length >= 3);
  const p = pool();
  if (p) {
    const m = canMessages ? await pgMessages(p, me, q, { chat, from, before, limit }) : { messages: [], total: 0, next: null, mentionIds: new Map<string, string>() };
    if (!withPublic) return { messages: m.messages, total: m.total, next: m.next, rooms: [], people: [], profiles: [] };
    const profiles = await pgProfiles(p, me, q.mentions);
    const [rooms, people] = await Promise.all([
      pgRooms(p, q, profiles.map((x) => x.id)).then((r) => (q.mentions.length && !profiles.length ? [] : r)),
      q.mentions.length ? Promise.resolve([]) : pgPeopleByTags(p, me, q.tags),
    ]);
    return { messages: m.messages, total: m.total, next: m.next, rooms, people, profiles };
  }
  const db = jsonDb();
  if (!db) return { messages: [], total: 0, next: null, rooms: [], people: [], profiles: [] };
  const m = canMessages ? jMessages(db, me, q, { chat, from, before, limit }) : { messages: [], total: 0, next: null };
  if (!withPublic) return { ...m, rooms: [], people: [], profiles: [] };
  const blocked = jBlocked(db, me);
  const profiles = db.users.filter((u) => q.mentions.includes(u.username) && !u.deletedAt && !blocked.has(u.id)).map((u) => jPerson(db, me, u));
  const hostIds = profiles.map((x) => x.id);
  const rooms =
    (q.tags.length || hostIds.length) && !(q.mentions.length && !profiles.length)
      ? db.rooms
          .filter((r) => {
            const text = `${r.title}\n${r.description ?? ""}`;
            const tags = extractHashtags(text);
            return q.tags.every((t) => tags.includes(t)) && (!hostIds.length || hostIds.includes(r.hostId ?? "")) && (!q.words.length || matchesWords(text, q.words));
          })
          .slice(0, 20)
          .map((r) => ({ id: r.id, title: r.title, description: clip(r.description ?? ""), topic: r.topic, hostId: r.hostId ?? "", live: true as const }))
      : [];
  const people =
    q.tags.length && !q.mentions.length
      ? db.users
          .filter((u) => !u.deletedAt && !u.isBot && !blocked.has(u.id) && u.bio && q.tags.every((t) => extractHashtags(u.bio ?? "").includes(t)))
          .slice(0, 20)
          .map((u) => jPerson(db, me, u))
      : [];
  return { ...m, rooms, people, profiles };
}

export async function suggestTags(me: string, prefix: string, limit = 8): Promise<HxSuggestion[]> {
  if (prefix && !/^[\p{L}\p{N}\p{M}_]{1,64}$/u.test(prefix)) return [];
  const p = pool();
  if (p) return pgSuggestTags(p, me, prefix, limit);
  const db = jsonDb();
  if (!db) return [];
  const score = new Map<string, HxSuggestion>();
  const bump = (tag: string, n: number, at: number) => {
    if (!tag.startsWith(prefix)) return;
    const s = score.get(tag) ?? { tag, count: 0, last: 0 };
    s.count += n;
    s.last = Math.max(s.last, at);
    score.set(tag, s);
  };
  for (const d of db.dms) if (!d.kind && (d.fromId === me || d.toId === me) && d.text.includes("#")) for (const t of extractHashtags(d.text)) bump(t, 3, d.createdAt);
  for (const r of db.rooms) for (const t of extractHashtags(`${r.title}\n${r.description ?? ""}`)) bump(t, 1, 0);
  for (const u of db.users) if (!u.deletedAt && u.bio) for (const t of extractHashtags(u.bio)) bump(t, 1, 0);
  return [...score.values()].sort((a, b) => b.last - a.last || b.count - a.count || a.tag.localeCompare(b.tag)).slice(0, limit);
}

export async function suggestPeople(me: string, prefix: string, limit = 8): Promise<HxPerson[]> {
  const pre = prefix.toLowerCase().slice(0, 40);
  const p = pool();
  if (p) return pgSuggestPeople(p, me, pre, limit);
  const db = jsonDb();
  if (!db) return [];
  const blocked = jBlocked(db, me);
  const follows = new Set(db.follows?.[me] ?? []);
  const contacts = new Set(db.dms.filter((d) => d.fromId === me || d.toId === me).map((d) => (d.fromId === me ? d.toId : d.fromId)));
  const hit = (u: JUser) => !pre || u.username.startsWith(pre) || u.name.toLowerCase().startsWith(pre) || u.name.toLowerCase().includes(" " + pre);
  return db.users
    .filter((u) => u.id !== me && !u.deletedAt && !u.isBot && !blocked.has(u.id) && hit(u))
    .sort((a, b) => +follows.has(b.id) - +follows.has(a.id) || +contacts.has(b.id) - +contacts.has(a.id) || +b.username.startsWith(pre) - +a.username.startsWith(pre))
    .slice(0, limit)
    .map((u) => jPerson(db, me, u));
}

/** members of a chat the caller is in (for the "from:" picker); null = not a member / no such chat */
export async function chatMembers(me: string, chat: string): Promise<HxMember[] | null> {
  const p = pool();
  if (p) return pgMembers(p, me, chat);
  const db = jsonDb();
  if (!db) return null;
  const peer = db.users.find((u) => u.id === chat && !u.deletedAt);
  const self = db.users.find((u) => u.id === me);
  if (!peer || !self) return null;
  return [self, peer].map((u) => ({ id: u.id, name: u.name, username: u.username, color: u.color, photoUrl: photoUrl(u.id, u.photoVersion) }));
}
