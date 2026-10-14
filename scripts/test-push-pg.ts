// Postgres check for contact-hash retention ("Tell me when contacts join", migration 024).
// Run: DATABASE_URL=postgresql://…/scratch_db npx tsx scripts/test-push-pg.ts   (applies all migrations to that DB)
import assert from "node:assert/strict";
import pg from "pg";
import { PgPersistence } from "../server/pg";
import { PgPushRepo } from "../server/push/repo";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL (a scratch database) is required");
  const db = new PgPersistence(url);
  await db.connectAndMigrate();
  const repo = new PgPushRepo(url);
  const raw = new pg.Pool({ connectionString: url });
  await raw.query("DELETE FROM contact_hashes WHERE owner_id LIKE 'npt_%'");
  await raw.query("DELETE FROM room_activity_members WHERE host_id LIKE 'npt_%' OR user_id LIKE 'npt_%'");
  await repo.replaceContactHashes("npt_a", ["h1", "h2"], false, false);
  await repo.replaceContactHashes("npt_b", ["h1"], false, true);
  await raw.query("UPDATE contact_hashes SET created_at = now() - interval '25 hours' WHERE owner_id LIKE 'npt_%'");
  assert.deepEqual((await repo.ownersOfHash("h1")).sort(), ["npt_b"], "expired unkept row no longer matches; kept row does");
  assert.equal(await repo.purgeExpiredHashes(), 2, "only the unkept rows are purged");
  assert.equal((await raw.query("SELECT count(*)::int n FROM contact_hashes WHERE owner_id = 'npt_b'")).rows[0].n, 1);
  await repo.replaceContactHashes("npt_a", ["h3"], false, false);
  await repo.keepContactHashes("npt_a");
  await raw.query("UPDATE contact_hashes SET created_at = now() - interval '40 days' WHERE owner_id = 'npt_a'");
  assert.deepEqual(await repo.ownersOfHash("h3"), ["npt_a"]);
  await repo.replaceContactHashes("npt_a", ["h3"], true, false); // re-sync with the switch off refreshes + unkeeps
  assert.equal((await raw.query("SELECT keep FROM contact_hashes WHERE owner_id = 'npt_a'")).rows[0].keep, false);
  await repo.deleteContactHashes("npt_a");
  await repo.deleteContactHashes("npt_b");
  await repo.noteRoomMember("npt_host", "npt_a", Date.now());
  await repo.noteRoomMember("npt_host", "npt_b", Date.now());
  await repo.noteRoomMember("npt_host", "npt_host", Date.now()); // a host is never their own activity audience
  assert.deepEqual((await repo.roomActivityMembers("npt_host", Date.now() - 1_000)).sort(), ["npt_a", "npt_b"]);
  await raw.query("UPDATE room_activity_members SET last_joined_at = now() - interval '8 days' WHERE host_id = 'npt_host' AND user_id = 'npt_a'");
  assert.deepEqual(await repo.roomActivityMembers("npt_host", Date.now() - 7 * 24 * 3600_000), ["npt_b"], "expired activity members are pruned");
  await repo.deleteUserData("npt_host");
  assert.deepEqual(await repo.roomActivityMembers("npt_host", 0), [], "account deletion removes the host activity audience");
  console.log("PASSED (pg contact-hash retention and room activity audience)");
  await raw.end();
  await repo.close();
  process.exit(0);

}
void main();
