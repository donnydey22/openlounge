// Durable copy of live call state (calls survive a restart, deploy or crash of the app server).
//   DATABASE_URL set → Postgres table live_calls (migration 033). Otherwise DATA_DIR/live-calls.json (local dev/tests).
// Writes are best-effort and never block signaling; the in-memory CallService stays the source of truth while running.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { chooseSsl } from "../pg";
import type { CallPhase } from "../../src/lib/types";

/** What a restarted server needs to keep a call going. Media credentials are re-minted on demand (never stored). */
export interface LiveCallRow {
  id: string;
  callerId: string;
  calleeId: string;
  video: boolean;
  everVideo: boolean;
  phase: Exclude<CallPhase, "ended">;
  createdAt: number;
  ackAt: number | null;
  answeredAt: number | null;
  answeredConn: string | null;
  pushed: boolean;
  audioAt: number | null;
  /** "mediasoup" | "livekit": the backend the call's media is on (the SFU room keeps running across our restart) */
  provider: string;
  /** primary provider kept after a TCP/LiveKit fallback, so restore-to-UDP still works after a restart */
  primaryProvider: string | null;
  savedAt: number;
}

export interface LiveCallStore {
  save(rows: LiveCallRow[]): Promise<void>;
  load(): Promise<LiveCallRow[]>;
}

export class MemoryLiveCallStore implements LiveCallStore {
  rows: LiveCallRow[] = [];
  saves = 0;
  async save(rows: LiveCallRow[]) {
    this.saves++;
    this.rows = rows.map((r) => ({ ...r }));
  }
  async load() {
    return this.rows.map((r) => ({ ...r }));
  }
}

export class FileLiveCallStore implements LiveCallStore {
  constructor(private file: string) {}
  async save(rows: LiveCallRow[]) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows));
    fs.renameSync(tmp, this.file);
  }
  async load() {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(v) ? (v as LiveCallRow[]) : [];
    } catch {
      return [];
    }
  }
}

export class PgLiveCallStore implements LiveCallStore {
  private pool: pg.Pool;
  constructor(url: string) {
    const { connectionString, ssl } = chooseSsl(url);
    this.pool = new pg.Pool({ connectionString, ssl, max: 1, connectionTimeoutMillis: 10_000 });
    this.pool.on("error", (e) => console.warn("[calls] live_calls pg idle error:", e.message));
  }
  /** full replace in one transaction: the set of live calls is tiny (two rows per concurrent call at most) */
  async save(rows: LiveCallRow[]) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const ids = rows.map((r) => r.id);
      await c.query("DELETE FROM live_calls WHERE NOT (id = ANY($1::text[]))", [ids]);
      for (const r of rows)
        await c.query(
          `INSERT INTO live_calls (id, caller_id, callee_id, state, updated_at) VALUES ($1,$2,$3,$4,now())
           ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
          [r.id, r.callerId, r.calleeId, JSON.stringify(r)],
        );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
  async load() {
    const r = await this.pool.query<{ state: LiveCallRow }>("SELECT state FROM live_calls");
    return r.rows.map((x) => x.state);
  }
}

export function defaultLiveCallStore(): LiveCallStore {
  if (process.env.DATABASE_URL) return new PgLiveCallStore(process.env.DATABASE_URL);
  return new FileLiveCallStore(path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "live-calls.json"));
}
