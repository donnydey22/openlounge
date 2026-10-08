// Store compliance: operator requests processed by the running server.
//  1) account_deletion_requests: operator-initiated account deletions (e.g. a verified email request from
// /privacy/delete-account, or closing internal test accounts). Rows in account_deletion_requests are processed by
// the running server, so the in-memory store, Postgres, push data and connected clients all stay consistent. It's
// the same code path as Settings > Delete account (deleteNow), without the end-user re-verification step: the
// request itself is the operator's authorization and is kept as the audit record (requested_by, reason, result).
//  2) account_provisioning_requests: internal screen-name + password accounts (App Review demo login, QA). The row
// carries only a scrypt hash (never a password). The account gets an unverified placeholder email identity on
// openlounge.app (accounts need one sign-in identity), so it can't receive mail or be taken over by email.
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

/** create pending operator-provisioned accounts; returns how many were handled */
export async function processProvisioningRequests(): Promise<number> {
  if (!pool) return 0;
  try {
    const { rows } = await pool.query<{ id: string; username: string; first_name: string; last_name: string; bio: string; password_hash: string; requested_by: string }>(
      "SELECT id, username, first_name, last_name, bio, password_hash, requested_by FROM account_provisioning_requests WHERE processed_at IS NULL ORDER BY requested_at LIMIT 10",
    );
    for (const r of rows) {
      let result: string;
      let userId: string | null = null;
      if (!/^scrypt\$\d+\$\d+\$\d+\$[\w-]+\$[\w-]+$/.test(r.password_hash)) result = "failed: password_hash must be a server scrypt hash";
      else {
        const handle = r.username.toLowerCase();
        const email = `${handle}@accounts.openlounge.app`;
        const c = store.createAccount(
          null,
          { firstName: r.first_name, lastName: r.last_name, username: r.username, bio: r.bio },
          { identity: { provider: "email", subject: email, email, verified: false }, passwordHash: r.password_hash },
        );
        if (c.ok) {
          userId = c.user.id;
          result = `created @${c.user.username}`;
          await store.flush().catch(() => {});
        } else result = `failed: ${c.error}`;
      }
      await pool.query("UPDATE account_provisioning_requests SET processed_at = $2, result = $3, user_id = $4 WHERE id = $1", [r.id, Date.now(), result, userId]);
      log.warn("operator account provisioning", { username: r.username, by: r.requested_by, result, userId });
    }
    return rows.length;
  } catch (err) {
    log.warn("provisioning queue failed", { err: String(err) });
    return 0;
  }
}

async function tick() {
  await processDeletionRequests();
  await processProvisioningRequests();
}

/** start polling (Postgres only; no-op with db.json storage) */
export function startDeletionQueue(intervalMs = 30_000) {
  if (!process.env.DATABASE_URL || timer) return;
  const { connectionString, ssl } = chooseSsl(process.env.DATABASE_URL);
  pool = new pg.Pool({ connectionString, ssl, max: 1, connectionTimeoutMillis: 10_000 });
  void tick();
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
}

export async function stopDeletionQueue() {
  if (timer) clearInterval(timer);
  timer = null;
  await pool?.end().catch(() => {});
  pool = null;
}
