#!/usr/bin/env node
// READ-ONLY dry-run of the self-destruct / view-once purge. Deletes nothing, writes nothing.
//   DATABASE_URL=... [MEDIA_DIR=/data/uploads/m] node scripts/media-purge-dryrun.mjs
// Runs every query inside a READ ONLY transaction. Prints counts, bytes and ids only (no URLs, no captions, no text).
import pg from "pg";
import fs from "node:fs";
import path from "node:path";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL required (use a read-only role or a replica)"); process.exit(2); }
const now = Date.now();
const pool = new pg.Pool({ connectionString: url, max: 1 });
const c = await pool.connect();
const dirBytes = (d) => { let n = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? dirBytes(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size; } catch { /* absent */ } return n; };
try {
  await c.query("BEGIN READ ONLY");
  await c.query("SET LOCAL statement_timeout = '30s'");
  const timed = (await c.query(
    `SELECT id, kind, view_once, ttl_seconds, expires_at, opened_at, size_bytes, files, message_id IS NOT NULL AS sent
       FROM media WHERE expires_at IS NOT NULL OR view_once OR ttl_seconds IS NOT NULL`)).rows;
  const due = timed.filter((r) => r.expires_at && Number(r.expires_at) <= now);
  const withHls = timed.filter((r) => r.files && (r.files.hls || r.files.hlsLow));
  const tombs = (await c.query(`SELECT reason, count(*)::int AS n FROM media_tombstones GROUP BY reason`)).rows;
  const all = (await c.query(`SELECT count(*)::int AS n, coalesce(sum(size_bytes),0)::bigint AS bytes FROM media`)).rows[0];
  const md = process.env.MEDIA_DIR;
  const onDisk = (id) => (md ? dirBytes(path.join(md, id.slice(0, 2), id)) : null);
  const summary = {
    at: new Date(now).toISOString(),
    mediaRows: all.n, mediaBytes: Number(all.bytes),
    timedRows: timed.length,
    wouldDeleteNow: due.map((r) => ({ id: r.id, kind: r.kind, viewOnce: r.view_once, reason: r.view_once && r.opened_at ? "viewed" : "expired", overdueMin: Math.round((now - Number(r.expires_at)) / 60000), bytes: Number(r.size_bytes), diskBytes: onDisk(r.id), variants: Object.keys(r.files || {}) })),
    timedWithHlsLadder: withHls.map((r) => ({ id: r.id, kind: r.kind, viewOnce: r.view_once })),
    tombstones: tombs,
    notes: "Due rows should be ~0: the live sweeper deletes on time. Anything overdue points at a stuck timer or a failed delete.",
  };
  console.log(JSON.stringify(summary, null, 1));
  await c.query("ROLLBACK");
} finally { c.release(); await pool.end(); }
