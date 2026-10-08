// Tiny persistence layer shared by the monetization modules (Premium, ads, creator accounts).
// Postgres when DATABASE_URL is set (own small pool, tables from migrations 022+), memory otherwise (local dev/tests).
// Each Collection is loaded fully at boot (these tables are small: memberships, campaigns, branding) and written
// through on every change. Counters (ad stats, analytics) use dedicated upserts.
import pg from "pg";
import { chooseSsl } from "../pg";

let pool: pg.Pool | null = null;
export function db(): pg.Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) {
    const { connectionString, ssl } = chooseSsl(url);
    pool = new pg.Pool({ connectionString, ssl, max: 3, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
    pool.on("error", (e) => console.warn("[monet] pg idle error:", e.message));
  }
  return pool;
}
/** tests: force memory mode */
let memoryOnly = false;
export function useMemoryDb(on = true) {
  memoryOnly = on;
}
const live = () => (memoryOnly ? null : db());

export async function q<R extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<R[]> {
  const p = live();
  if (!p) return [];
  return (await p.query<R>(sql, params)).rows;
}

/**
 * A table with a text primary key `id`, a few indexed scalar columns, and everything else in `data JSONB`.
 * Rows are kept in memory (Map) and written through to Postgres.
 */
export class Collection<T extends { id: string }> {
  rows = new Map<string, T>();
  constructor(
    readonly table: string,
    /** scalar columns mirrored out of the row for SQL reporting/indexes (must exist in the migration) */
    readonly cols: (keyof T & string)[] = [],
  ) {}
  async load() {
    const p = live();
    if (!p) return;
    const rs = await p.query<{ id: string; data: T }>(`SELECT id, data FROM ${this.table}`);
    this.rows.clear();
    for (const r of rs.rows) this.rows.set(r.id, { ...r.data, id: r.id });
  }
  get(id: string) {
    return this.rows.get(id) ?? null;
  }
  all() {
    return [...this.rows.values()];
  }
  where(pred: (r: T) => boolean) {
    return this.all().filter(pred);
  }
  async put(row: T) {
    this.rows.set(row.id, row);
    const p = live();
    if (!p) return row;
    const cols = ["id", ...this.cols.map(snake), "data", "updated_at"];
    const vals: unknown[] = [row.id, ...this.cols.map((c) => (row[c] ?? null) as unknown), JSON.stringify(row), Date.now()];
    const ph = vals.map((_, i) => `$${i + 1}`).join(",");
    const upd = cols.slice(1).map((c) => `${c}=EXCLUDED.${c}`).join(", ");
    await p.query(`INSERT INTO ${this.table} (${cols.join(",")}) VALUES (${ph}) ON CONFLICT (id) DO UPDATE SET ${upd}`, vals);
    return row;
  }
  async remove(id: string) {
    this.rows.delete(id);
    const p = live();
    if (p) await p.query(`DELETE FROM ${this.table} WHERE id=$1`, [id]);
  }
}
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());

export const flag = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? "");
