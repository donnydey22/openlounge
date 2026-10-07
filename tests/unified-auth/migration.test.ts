// Migration 005 on a database that looks like production today (migrations 001–004, phone users, legacy + v2
// sessions): non-destructive, backfills phone identities, idempotent, and existing phone login / tokens keep working.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { setTestEnv, startApp, wipeDb, sql, api, phoneLogin, type App } from "./harness";

const DB = (process.env.TEST_DATABASE_URL || "postgresql://ua@127.0.0.1:55433/ua_test").replace(/\/[^/]+$/, "/ua_migration");
setTestEnv({ providers: false, dbUrl: DB });
let app: App;
const legacyToken = randomBytes(32).toString("base64url");
const MIG = path.join(process.cwd(), "server", "migrations");

before(async () => {
  try {
    await sql("CREATE DATABASE ua_migration", [], DB.replace(/\/[^/]+$/, "/postgres"));
  } catch {
    /* exists */
  }
  await wipeDb(DB);
  // schema as of 004 (what production runs now)
  await sql("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())", [], DB);
  for (const f of ["001_init.sql", "002_rename_meta.sql", "003_sessions_v2.sql", "004_dm_read_receipts.sql"]) {
    await sql(fs.readFileSync(path.join(MIG, f), "utf8"), [], DB);
    await sql("INSERT INTO schema_migrations (version) VALUES ($1)", [f], DB);
  }
  const now = Date.now();
  await sql(
    `INSERT INTO users (id, name, username, color, bio, phone, created_at) VALUES
     ('u_sam', 'Sam', 'sam', '#3B82F6', 'host of things', '+14155550142', $1),
     ('u_lee', 'Lee', 'lee', '#22C55E', '', '+14155550143', $1),
     ('u_nophone', 'Old Demo', 'olddemo', '#F97316', '', NULL, $1)`,
    [now - 86_400_000],
    DB,
  );
  await sql("INSERT INTO follows (follower_id, followee_id) VALUES ('u_sam', 'u_lee')", [], DB);
  await sql("INSERT INTO dms (id, conversation_id, from_id, from_name, from_color, to_id, text, created_at) VALUES ('m1', 'u_lee|u_sam', 'u_lee', 'Lee', '#22C55E', 'u_sam', 'pre-migration DM', $1)", [now - 1000], DB);
  // a pre-v2 legacy session for Sam (only the hash is stored)
  const h = createHash("sha256").update(legacyToken).digest("hex");
  await sql("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, id, scheme, legacy_hash) VALUES ($1, 'u_sam', $2, $3, $2, $4, 1, $1)", [h, now - 5000, now + 86_400_000, `s_${h.slice(0, 32)}`], DB);
  app = await startApp();
});

after(async () => app?.close());

test("005 applied, phone numbers backfilled as verified phone identities, nothing else touched", async () => {
  const mig = await sql<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version", [], DB);
  assert.deepEqual(mig.map((m) => m.version), ["001_init.sql", "002_rename_meta.sql", "003_sessions_v2.sql", "004_dm_read_receipts.sql", "005_unified_auth.sql"]);
  const ids = await sql("SELECT user_id, provider, provider_subject, verified FROM auth_identities ORDER BY user_id", [], DB);
  assert.deepEqual(ids, [
    { user_id: "u_lee", provider: "phone", provider_subject: "+14155550143", verified: true },
    { user_id: "u_sam", provider: "phone", provider_subject: "+14155550142", verified: true },
  ]);
  const users = await sql<{ id: string; phone: string | null; password_hash: string | null }>("SELECT id, phone, password_hash FROM users ORDER BY id", [], DB);
  assert.equal(users.length, 3);
  assert.deepEqual(users.map((u) => u.phone), ["+14155550143", null, "+14155550142"]);
  assert.ok(users.every((u) => u.password_hash === null));
  assert.equal((await sql("SELECT * FROM dms", [], DB)).length, 1);
  assert.equal((await sql("SELECT * FROM follows", [], DB)).length, 1);
});

test("005 is idempotent (re-running it changes nothing)", async () => {
  await sql(fs.readFileSync(path.join(MIG, "005_unified_auth.sql"), "utf8"), [], DB);
  assert.equal((await sql("SELECT * FROM auth_identities", [], DB)).length, 2);
});

test("existing phone user logs in by OTP after the migration → same account, profile, follows, DMs", async () => {
  const r = await phoneLogin(app.wsUrl, "+14155550142");
  assert.equal(r.res.status, "existing");
  assert.equal(r.res.user.id, "u_sam");
  assert.equal(r.res.user.bio, "host of things");
  assert.deepEqual(r.res.following, ["u_lee"]);
  const hist = await r.client.req("dm:history", { peerId: "u_lee" });
  assert.equal(hist.messages[0].text, "pre-migration DM");
  r.client.close();
});

test("pre-existing tokens still validate (GET /auth/validate 200) and garbage is 401", async () => {
  const v = await api(app.base, "/auth/validate", undefined, { token: legacyToken });
  assert.equal(v.status, 200);
  assert.equal(v.data.user.id, "u_sam");
  assert.equal((await api(app.base, "/auth/validate", undefined, { token: randomBytes(32).toString("base64url") })).status, 401);
});

test("no providers configured → only phone is offered", async () => {
  assert.deepEqual((await api(app.base, "/auth/providers")).data.providers, { phone: true, email: false, google: false, apple: false });
});
