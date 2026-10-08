// Migration 015: existing 1:1 DMs are backfilled into conversations + conversation_members (with read cursors),
// nothing in dms / dm_reads changes, and re-running is a no-op.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import "./env";
import { setTestEnv, startApp, wipeDb, sql, type App } from "../unified-auth/harness";

setTestEnv({ providers: false });
let app: App;
before(async () => {
  await wipeDb();
  app = await startApp(); // applies every migration on an empty schema
  await app.close();
});
after(async () => {});

test("015 backfills DM conversations and members without touching dms", async () => {
  const now = Date.now();
  await sql("INSERT INTO users (id, name, username, color, bio, created_at, base_followers, base_following) VALUES ('u_a','A','aa','#111','',$1,0,0),('u_b','B','bb','#111','',$1,0,0),('u_c','C','cc','#111','',$1,0,0)", [now]);
  await sql(
    `INSERT INTO dms (id, conversation_id, from_id, from_name, from_color, to_id, text, created_at) VALUES
     ('m1','u_a|u_b','u_a','A','#111','u_b','hi',$1), ('m2','u_a|u_b','u_b','B','#111','u_a','yo',$2), ('m3','u_a|u_c','u_c','C','#111','u_a','hey',$3)`,
    [now - 3000, now - 2000, now - 1000],
  );
  await sql("INSERT INTO dm_reads (user_id, peer_id, last_read_at) VALUES ('u_a','u_b',$1)", [now - 2000]);
  const dmsBefore = await sql("SELECT * FROM dms ORDER BY id");
  // simulate a database from before 015
  await sql("DROP TABLE conversation_service, conversation_invites, conversation_pins, conversation_photos, conversation_members, conversations");
  await sql("DELETE FROM schema_migrations WHERE version = '015_conversations.sql'");
  const file = fs.readFileSync(path.join(process.cwd(), "server/migrations/015_conversations.sql"), "utf8");
  await sql(file);
  const convs = await sql<{ id: string; type: string; created_at: string }>("SELECT id, type, created_at FROM conversations ORDER BY id");
  assert.deepEqual(convs.map((c) => [c.id, c.type]), [["u_a|u_b", "dm"], ["u_a|u_c", "dm"]]);
  assert.equal(Number(convs[0].created_at), now - 3000);
  const members = await sql<{ conversation_id: string; user_id: string; last_read_at: string; role: string }>("SELECT * FROM conversation_members ORDER BY conversation_id, user_id");
  assert.equal(members.length, 4);
  assert.equal(Number(members.find((m) => m.conversation_id === "u_a|u_b" && m.user_id === "u_a")!.last_read_at), now - 2000);
  assert.ok(members.every((m) => m.role === "member"));
  // idempotent
  await sql(file);
  assert.equal((await sql("SELECT * FROM conversation_members")).length, 4);
  assert.deepEqual(await sql("SELECT * FROM dms ORDER BY id"), dmsBefore, "dms untouched");
  // reports accept 'group'
  await sql("INSERT INTO content_reports (id, reporter_id, target_type, target_id, reason, note, snapshot, status, created_at) VALUES ('r1','u_a','group','g_x','spam','','','open',$1)", [now]);
});
