// FX-052: pg_restore --list piped into `grep -q` under pipefail falsely failed good backups (EPIPE race).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const scripts = ["ops/db-backup/openlounge-db-restore-verify.sh", "ops/db-backup/railway/export-backup.sh", "scripts/pg-backup.sh"];

test("backup list check never pipes pg_restore --list into grep", () => {
  for (const f of scripts) {
    const src = readFileSync(f, "utf8");
    assert.ok(src.includes("--list"), `${f} still lists the archive`);
    assert.ok(!/--list[^\n]*\|\s*grep/.test(src), `${f} pipes pg_restore --list into grep`);
  }
});

test("capture-then-grep survives a large listing where the pipe form fails", () => {
  // A fake lister printing a match first, then lots more output, like a real table of contents.
  const fake = `lister(){ echo "TABLE DATA public users"; for i in $(seq 1 20000); do echo "; entry $i padding padding padding"; done; }`;
  const pipe = spawnSync("bash", ["-c", `set -euo pipefail; ${fake}; lister | grep -qE 'TABLE.*public'`]);
  const fixed = spawnSync("bash", ["-c", `set -euo pipefail; ${fake}; t=$(mktemp); lister >"$t"; grep -qE 'TABLE.*public' "$t"; rm -f "$t"`]);
  assert.notEqual(pipe.status, 0, "pipe form should reproduce the false failure");
  assert.equal(fixed.status, 0, "capture-then-grep must pass");
});
