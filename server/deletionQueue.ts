// Store compliance: operator-initiated account deletions (e.g. a verified email request from
// /privacy/delete-account, or closing internal test accounts). Rows in account_deletion_requests are processed by
// the running server, so the in-memory store, Postgres, push data and connected clients all stay consistent. It's
// the same code path as Settings > Delete account (deleteNow), without the end-user re-verification step: the
// request itself is the operator's authorization and is kept as the audit record (requested_by, reason, result).
import pg from "pg";
import { chooseSsl } from "./pg";
import { deleteNow } from "./accountDeletion";
import { push } from "./push";
import { store } from "./store";
import { log } from "./log";

let pool: pg.Pool | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;

/** process pending requests once; returns how many were handled */
export async function processDeletionRequests(): Promise<number> {
  if (!pool || running) return 0;
  running = true;
  try {
    const { rows } = await pool.query<{ id: string; user_id: string; requested_by: string }>(
      "SELECT id, user_id, requested_by FROM account_deletion_requests WHERE processed_at IS NULL ORDER BY requested_at LIMIT 20",
    );
    for (const r of rows) {
      let result: string;
      if (!store.users.has(r.user_id)) result = store.isDeletedUser(r.user_id) ? "already deleted" : "not found";
      else {
        const d = await deleteNow(r.user_id, push()).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
        result = d.ok ? `deleted (${d.revokedSessions} session(s) revoked)` : `failed: ${"error" in d ? d.error : "unknown"}`;
      }
      await pool.query("UPDATE account_deletion_requests SET processed_at = $2, result = $3 WHERE id = $1", [r.id, Date.now(), result]);
      log.warn("operator account deletion", { userId: r.user_id, by: r.requested_by, result });
    }
    return rows.length;
  } catch (err) {
    log.warn("deletion queue failed", { err: String(err) });
    return 0;
  } finally {
    running = false;
  }
}

/** start polling (Postgres only; no-op with db.json storage) */
export function startDeletionQueue(intervalMs = 30_000) {
  if (!process.env.DATABASE_URL || timer) return;
  const { connectionString, ssl } = chooseSsl(process.env.DATABASE_URL);
  pool = new pg.Pool({ connectionString, ssl, max: 1, connectionTimeoutMillis: 10_000 });
  void processDeletionRequests();
  timer = setInterval(() => void processDeletionRequests(), intervalMs);
  timer.unref();
}

export async function stopDeletionQueue() {
  if (timer) clearInterval(timer);
  timer = null;
  await pool?.end().catch(() => {});
  pool = null;
}
