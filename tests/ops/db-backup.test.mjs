import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const bashSyntax = (file) => spawnSync("bash", ["-n", path.join(root, file)], { encoding: "utf8" });

test("Railway exporter is private-network-only, read-only, encrypted before SFTP, and host-key pinned", () => {
  const script = read("ops/db-backup/railway/export-backup.sh");
  assert.match(script, /PRIVATE_POSTGRES_HOST="postgres\.railway\.internal"/);
  assert.match(script, /BACKUP_PGHOST must remain Railway-private/);
  assert.match(script, /BACKUP_PGUSER.*openlounge_backup_ro/);
  assert.doesNotMatch(script, /\$\{?DATABASE_URL/);
  assert.match(script, /RECOVERY_RECIPIENT="age1nnl9tv0w5tjk3kttljyflzllrhna99l6jnzt5dw5ctuhefz2n3gqcel5j2"/);
  assert.match(script, /BACKUP_AGE_RESTORE_RECIPIENT/);
  assert.match(script, /pg_export_snapshot\(\)/);
  assert.match(script, /--snapshot="\$snapshot"/);
  assert.match(script, /SFTP_TARGET.*openlounge-backup@165\.232\.137\.71/);
  assert.match(script, /StrictHostKeyChecking=yes/);
  assert.match(script, /UserKnownHostsFile="\$known_hosts"/);
  assert.match(script, /put \$archive \$archive_name\.partial/);
  assert.match(script, /put \$manifest \$manifest_name\.partial/);
  assert.match(script, /rename \$manifest_name\.partial \$manifest_name/);
  assert.match(script, /BACKUP_PGSSLMODE:-verify-full/);
  assert.match(script, /BACKUP_PGSSLROOTCERT_PEM is required/);
  assert.match(script, /BACKUP_MANIFEST_SIGNING_KEY is required/);
  assert.match(script, /minisign -S/);
  assert.match(script, /BACKUP_EXPORT_TIMEOUT_SEC/);
  assert.match(script, /BACKUP_SNAPSHOT_HOLD_SEC must exceed BACKUP_EXPORT_TIMEOUT_SEC/);
  assert.match(script, /BACKUP_TEST_MODE/);
});

test("droplet receiver has no source database path and verifies encrypted receipts before retention", () => {
  const script = read("ops/db-backup/openlounge-db-restore-verify.sh");
  assert.doesNotMatch(script, /postgres\.railway\.internal/);
  assert.doesNotMatch(script, /PGPASSWORD/);
  assert.match(script, /BACKUP_AGE_IDENTITY_FILE/);
  assert.match(script, /BACKUP_MANIFEST_VERIFY_KEY_FILE/);
  assert.match(script, /manifest signature verification failed/);
  assert.match(script, /BACKUP_RECEIPT_STAGE_ROOT/);
  assert.match(script, /mv "\$incoming_manifest" "\$receipt_stage\/manifest"/);
  assert.match(script, /replayed or stale signed receipt/);
  assert.match(script, /cleanup_stale_partials/);
  assert.match(script, /quarantine_receipt/);
  assert.match(script, /--decrypt --identity/);
  assert.match(script, /cmp --silent "\$source_counts" "\$restored_counts"/);
  assert.match(script, /BACKUP_DAILY_KEEP:-7/);
  assert.match(script, /BACKUP_WEEKLY_KEEP:-4/);
  assert.match(script, /mountpoint -q "\$BACKUP_ROOT"/);
  assert.match(script, /findmnt -n -o SOURCE --target "\$BACKUP_ROOT"/);
  assert.match(script, /flock -n 9/);
  assert.match(script, /received artifact is missing or unsafe/);
  assert.match(script, /receiver group/);
  assert.match(script, /clean_transients/);
});

test("Railway cron and droplet receiver units are bounded, journaled, and receipt-driven", () => {
  const service = read("ops/db-backup/openlounge-db-restore-verify.service");
  for (const directive of ["User=openlounge-backup-verify", "Group=openlounge-backup-verify", "SupplementaryGroups=openlounge-backup-ingress", "TimeoutStartSec=6h", "CPUQuota=20%", "MemoryMax=512M", "IOSchedulingClass=idle", "NoNewPrivileges=yes", "ProtectSystem=strict", "RestrictAddressFamilies=AF_UNIX", "IPAddressDeny=any", "OnFailure=openlounge-db-restore-verify-failure@%n.service", "StandardError=journal"]) {
    assert.match(service, new RegExp(`^${directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
  const pathUnit = read("ops/db-backup/openlounge-db-restore-verify.path");
  assert.match(pathUnit, /^PathChanged=\/srv\/openlounge-backups\/incoming$/m);
  assert.match(pathUnit, /^PathExistsGlob=\/srv\/openlounge-backups\/incoming\/openlounge-\*\.dump\.age\.manifest$/m);
  const failure = read("ops/db-backup/openlounge-db-restore-verify-failure@.service");
  assert.match(failure, /logger --priority user\.err --tag openlounge-db-restore-verify/);
  const drill = read("ops/db-backup/run-failure-drill.sh");
  assert.match(drill, /systemctl start openlounge-db-restore-verify\.service/);
  assert.match(drill, /failure alert unit did not emit/);
  assert.match(drill, /failure drill passed/);
});

test("backup scripts and image definition have valid static syntax and no committed secret material", () => {
  for (const file of ["ops/db-backup/railway/export-backup.sh", "ops/db-backup/openlounge-db-restore-verify.sh", "ops/db-backup/run-failure-drill.sh"]) {
    const shell = bashSyntax(file);
    assert.equal(shell.status, 0, shell.stderr);
  }
  const railwayEnv = read("ops/db-backup/railway/backup.env.example");
  const hostEnv = read("ops/db-backup/backup.env.example");
  assert.doesNotMatch(railwayEnv, /AGE-SECRET-KEY-/);
  assert.doesNotMatch(hostEnv, /AGE-SECRET-KEY-/);
  assert.doesNotMatch(railwayEnv, /-----BEGIN OPENSSH PRIVATE KEY-----/);
  const dockerfile = read("ops/db-backup/railway/Dockerfile");
  assert.match(dockerfile, /FROM postgres:18\.6-bookworm@sha256:/);
  assert.match(dockerfile, /minisign/);
  assert.match(dockerfile, /USER openlounge-backup/);
});
