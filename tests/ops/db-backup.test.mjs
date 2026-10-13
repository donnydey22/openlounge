import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const bashSyntax = (file) => spawnSync("bash", ["-n", path.join(root, file)], { encoding: "utf8" });

test("backup runner is encrypted, snapshot-consistent, verified, and retention-bounded", () => {
  const script = read("ops/db-backup/openlounge-db-backup.sh");
  assert.match(script, /service=\$BACKUP_PG_SERVICE/);
  assert.doesNotMatch(script, /DATABASE_URL/);
  assert.match(script, /pg_export_snapshot\(\)/);
  assert.match(script, /--snapshot="\$snapshot"/);
  assert.match(script, /--recipients-file "\$BACKUP_AGE_RECIPIENT_FILE"/);
  assert.match(script, /--identity "\$BACKUP_AGE_IDENTITY_FILE"/);
  assert.match(script, /cmp --silent "\$source_counts" "\$restored_counts"/);
  assert.match(script, /BACKUP_DAILY_KEEP:-7/);
  assert.match(script, /BACKUP_WEEKLY_KEEP:-4/);
  assert.match(script, /mountpoint -q "\$BACKUP_ROOT"/);
  assert.match(script, /findmnt -n -o SOURCE --target "\$BACKUP_ROOT"/);
  assert.match(script, /BACKUP_EXPECTED_MOUNT_SOURCE/);
  assert.match(script, /pg_database_size\(current_database\(\)\)/);
  assert.match(script, /BACKUP_CAPACITY_MULTIPLIER:-3/);
  assert.match(script, /dynamic_shared_memory_type=mmap/);
  assert.match(script, /committed=1/);
  assert.match(script, /promoted_paths/);
  assert.match(script, /flock -n 9/);
  assert.match(script, /FAILURE: scheduled backup or restore verification/);
});

test("timer is persistent, daily, and jittered while service is bounded and journaled", () => {
  const timer = read("ops/db-backup/openlounge-db-backup.timer");
  assert.match(timer, /^OnCalendar=\*-\*-\* 03:30:00 UTC$/m);
  assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^RandomizedDelaySec=15m$/m);
  const service = read("ops/db-backup/openlounge-db-backup.service");
  for (const directive of ["User=openlounge-backup", "TimeoutStartSec=1h", "CPUQuota=20%", "MemoryMax=512M", "IOSchedulingClass=idle", "NoNewPrivileges=yes", "ProtectSystem=strict", "OnFailure=openlounge-db-backup-failure@%n.service", "StandardError=journal"]) assert.match(service, new RegExp(`^${directive.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}$`, "m"));
  assert.doesNotMatch(service, /ConditionPathIsMountPoint/);
  const failure = read("ops/db-backup/openlounge-db-backup-failure@.service");
  assert.match(failure, /logger --priority user\.err --tag openlounge-db-backup/);
});

test("backup artifacts and units have valid static syntax", () => {
  const shell = bashSyntax("ops/db-backup/openlounge-db-backup.sh");
  assert.equal(shell.status, 0, shell.stderr);
  const env = read("ops/db-backup/backup.env.example");
  assert.doesNotMatch(env, /postgres(?:ql)?:\/\/[^\s]+/i);
  assert.doesNotMatch(env, /AGE-SECRET-KEY-/);
});
