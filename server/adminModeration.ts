// Store compliance: moderator enforcement on top of the UGC report queue (App Store 1.2 requires "timely
// responses" to reports and removal of violating content; Google Play's UGC policy requires the same).
//
// Self-contained on purpose (other workers own store.ts / auth): it uses the store's public state and methods,
// and installs one thin wrapper around store.authenticate so a suspended account's tokens are rejected
// everywhere (HTTP API + WebSocket) with reason "revoked" — clients then sign out.
//
// Actions (admin only, see moderation.ts isAdmin):
//   remove_content  delete the reported DM / room-chat message, or end the reported room
//   end_room        end the room (for a room report, or the room a reported message was in)
//   suspend_user    suspend the responsible account: revoke every session now, reject tokens until unsuspended
//   unsuspend_user  lift a suspension
// Every action is written to moderation_actions (Postgres) and marks the report "actioned".
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { store } from "./store";
import { chooseSsl } from "./pg";
import { log } from "./log";

export const MOD_ACTIONS = ["remove_content", "end_room", "suspend_user", "unsuspend_user"] as const;
export type ModAction = (typeof MOD_ACTIONS)[number];

type Suspension = { userId: string; reason: string; byId: string; createdAt: number };

const suspended = new Map<string, Suspension>();
let pool: pg.Pool | null = null;
let loaded: Promise<void> | null = null;

const fileFor = () => path.join(process.env.DATA_DIR || "data", "moderation.json");

function db() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    const { connectionString, ssl } = chooseSsl(process.env.DATABASE_URL);
    pool = new pg.Pool({ connectionString, ssl, max: 2, connectionTimeoutMillis: 10_000 });
    pool.on("error", (e) => log.warn("moderation pg idle error", { err: e.message }));
  }
  return pool;
}

/** Load suspensions once (after store.init has applied migrations). Retries on the next call if it failed. */
function ensureLoaded() {
  loaded ??= (async () => {
    const p = db();
    if (p) {
      const r = await p.query<{ user_id: string; reason: string; by_id: string; created_at: string }>("SELECT * FROM user_suspensions");
      suspended.clear();
      for (const row of r.rows) suspended.set(row.user_id, { userId: row.user_id, reason: row.reason, byId: row.by_id, createdAt: Number(row.created_at) });
    } else {
      try {
        const j = JSON.parse(fs.readFileSync(fileFor(), "utf8")) as { suspensions?: Suspension[] };
        for (const s of j.suspensions ?? []) suspended.set(s.userId, s);
      } catch {
        /* no file yet */
      }
    }
  })().catch((err) => {
    loaded = null;
    throw err;
  });
  return loaded;
}

function saveFile() {
  if (db()) return;
  fs.mkdirSync(path.dirname(fileFor()), { recursive: true });
  fs.writeFileSync(fileFor(), JSON.stringify({ suspensions: [...suspended.values()] }, null, 2));
}

export function isSuspended(userId: string) {
  return suspended.has(userId);
}

// ---- token gate: one wrapper around store.authenticate (HTTP + WebSocket both call it) ----
type AuthFn = typeof store.authenticate;
const MARK = Symbol.for("openlounge.moderationGate");
const holder = store as unknown as Record<symbol, boolean> & { authenticate: AuthFn };
if (!holder[MARK]) {
  holder[MARK] = true;
  const original: AuthFn = store.authenticate.bind(store);
  store.authenticate = (async (token: unknown) => {
    const r = await original(token);
    if (!r.ok) return r;
    try {
      await ensureLoaded();
    } catch (err) {
      // never lock everyone out because the suspension list couldn't load; retried on the next request
      log.warn("moderation: suspension list unavailable", { err: String(err) });
      return r;
    }
    return suspended.has(r.userId) ? { ok: false as const, reason: "revoked" as const } : r;
  }) as AuthFn;
}

async function audit(a: { reportId: string | null; action: ModAction; targetType: string; targetId: string; byId: string; note: string }) {
  const row = { id: `ma_${randomUUID()}`, ...a, createdAt: Date.now() };
  log.warn("moderation action", { action: a.action, targetType: a.targetType, targetId: a.targetId, by: a.byId, report: a.reportId });
  const p = db();
  if (!p) return row;
  await p.query(
    "INSERT INTO moderation_actions (id, report_id, action, target_type, target_id, by_id, note, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [row.id, row.reportId, row.action, row.targetType, row.targetId, row.byId, row.note.slice(0, 1000), row.createdAt],
  );
  return row;
}

export async function suspendUser(userId: string, byId: string, reason = "") {
  await ensureLoaded();
  if (!store.users.has(userId)) return { ok: false as const, status: 404, error: "User not found" };
  if (userId === byId) return { ok: false as const, status: 400, error: "You can't suspend yourself" };
  const s: Suspension = { userId, reason: reason.slice(0, 500), byId, createdAt: Date.now() };
  const p = db();
  if (p)
    await p.query(
      "INSERT INTO user_suspensions (user_id, reason, by_id, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET reason = EXCLUDED.reason, by_id = EXCLUDED.by_id, created_at = EXCLUDED.created_at",
      [s.userId, s.reason, s.byId, s.createdAt],
    );
  suspended.set(userId, s);
  saveFile();
  // sign them out everywhere right now (open sockets get session:revoked)
  const revoked = store.revokeSession(undefined, { allForUser: userId });
  // leave any room they're in
  for (const r of store.rooms.values()) if (!r.ended && r.participants.has(userId)) store.leave(r.id, userId);
  return { ok: true as const, revokedSessions: revoked.length };
}

export async function unsuspendUser(userId: string) {
  await ensureLoaded();
  const p = db();
  if (p) await p.query("DELETE FROM user_suspensions WHERE user_id = $1", [userId]);
  const had = suspended.delete(userId);
  saveFile();
  return { ok: true as const, changed: had };
}

function removeDm(messageId: string) {
  for (const list of store.dms.values()) {
    const i = list.findIndex((m) => m.id === messageId);
    if (i >= 0) {
      list.splice(i, 1);
      return true;
    }
  }
  return false;
}

function removeRoomChat(messageId: string, roomId: string | null) {
  const rooms = roomId ? [store.rooms.get(roomId)].filter((r) => !!r) : [...store.rooms.values()];
  for (const r of rooms) {
    const i = r!.chat.findIndex((m) => m.id === messageId);
    if (i >= 0) {
      r!.chat.splice(i, 1);
      return true;
    }
  }
  return false;
}

function endRoom(roomId: string | null) {
  const r = roomId ? store.rooms.get(roomId) : undefined;
  if (!r || r.ended) return false;
  return store.endRoom(r.id, r.hostId).ok;
}

/** Apply a moderator action to a report. */
export async function applyReportAction(reportId: string, action: unknown, byId: string, note: unknown) {
  if (!MOD_ACTIONS.includes(action as ModAction)) return { ok: false as const, status: 400, error: "Unknown action" };
  const report = store.reports.find((r) => r.id === reportId);
  if (!report) return { ok: false as const, status: 404, error: "Report not found" };
  const why = typeof note === "string" ? note.slice(0, 1000) : "";
  const a = action as ModAction;
  let done = false;
  let detail = "";
  if (a === "remove_content") {
    if (report.targetType === "dm") done = removeDm(report.targetId);
    else if (report.targetType === "message") done = removeRoomChat(report.targetId, report.roomId);
    else if (report.targetType === "room") done = endRoom(report.targetId);
    else return { ok: false as const, status: 400, error: "For a profile report, suspend the account (or ask them to edit it)" };
    detail = done ? "removed" : "already gone";
  } else if (a === "end_room") {
    if (!report.roomId) return { ok: false as const, status: 400, error: "This report isn't about a room" };
    done = endRoom(report.roomId);
    detail = done ? "room ended" : "room already ended";
  } else if (a === "suspend_user") {
    if (!report.targetUserId) return { ok: false as const, status: 400, error: "No account to suspend" };
    const r = await suspendUser(report.targetUserId, byId, why || `report ${report.id}: ${report.reason}`);
    if (!r.ok) return r;
    done = true;
    detail = `suspended, ${r.revokedSessions} session(s) revoked`;
  } else {
    if (!report.targetUserId) return { ok: false as const, status: 400, error: "No account" };
    done = (await unsuspendUser(report.targetUserId)).changed;
    detail = done ? "unsuspended" : "was not suspended";
  }
  if (a !== "unsuspend_user") store.setReportStatus(report.id, "actioned");
  await store.flush().catch(() => {});
  await audit({ reportId: report.id, action: a, targetType: report.targetType, targetId: report.targetId, byId, note: why });
  return { ok: true as const, done, detail, report, suspended: report.targetUserId ? isSuspended(report.targetUserId) : false };
}

/** for the admin page: who is suspended */
export async function listSuspensions() {
  await ensureLoaded();
  return [...suspended.values()].map((s) => ({ ...s, name: store.users.get(s.userId)?.name ?? "(deleted)", username: store.users.get(s.userId)?.username ?? "" }));
}
