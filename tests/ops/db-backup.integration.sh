#!/usr/bin/env bash
# Local-only integration test: creates a disposable PostgreSQL source and proves that
# the backup runner encrypts, restores, and compares row counts. It never reads Railway.
set -Eeuo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pg_bin="${BACKUP_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
for command in initdb pg_ctl createdb psql pg_dump pg_restore; do
  [[ -x "$pg_bin/$command" ]] || { echo "missing $pg_bin/$command" >&2; exit 77; }
done
command -v age >/dev/null || { echo "age is required" >&2; exit 77; }

root=$(mktemp -d /tmp/openlounge-db-backup-test.XXXXXX)
source_data="$root/source-data"
source_socket="$root/source-socket"
backup_root="$root/backups"
port=55446
cleanup() {
  local rc=$?
  if (( rc != 0 )) && [[ -f "${log:-}" ]]; then
    printf '%s\n' '--- backup runner log ---' >&2
    cat "$log" >&2 || true
  fi
  "$pg_bin/pg_ctl" -D "$source_data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$root"
  exit "$rc"
}
trap cleanup EXIT
mkdir -p "$source_socket" "$backup_root"
"$pg_bin/initdb" --no-instructions --auth-local=trust --auth-host=reject --encoding=UTF8 --no-locale -D "$source_data" >/dev/null
"$pg_bin/pg_ctl" -D "$source_data" -o "-h '' -k '$source_socket' -p $port" -w start >/dev/null
"$pg_bin/createdb" --host="$source_socket" --port="$port" backup_source
"$pg_bin/psql" "host=$source_socket port=$port dbname=backup_source" -X -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL);
CREATE TABLE dms (id integer PRIMARY KEY, body text NOT NULL);
INSERT INTO users VALUES (1, 'one'), (2, 'two'), (3, 'three');
INSERT INTO dms VALUES (10, 'hello'), (11, 'backup');
SQL

service_file="$root/pg_service.conf"
pass_file="$root/.pgpass"
cat >"$service_file" <<EOF
[openlounge-backup-source]
host=$source_socket
port=$port
dbname=backup_source
user=$(id -un)
sslmode=disable
EOF
: >"$pass_file"
chmod 600 "$pass_file"
identity="$root/age-identity.txt"
recipient="$root/age-recipients.txt"
age-keygen -o "$identity" >/dev/null
age-keygen -y "$identity" >"$recipient"

missing_mount="$root/not-mounted"
missing_log="$root/missing-mount.log"
mkdir -p "$missing_mount"
set +e
PGSERVICEFILE="$service_file" \
PGPASSFILE="$pass_file" \
BACKUP_PG_SERVICE=openlounge-backup-source \
BACKUP_ROOT="$missing_mount" \
BACKUP_REQUIRE_MOUNT=1 \
BACKUP_EXPECTED_MOUNT_SOURCE=/dev/mapper/openlounge-backups \
BACKUP_AGE_RECIPIENT_FILE="$recipient" \
BACKUP_AGE_IDENTITY_FILE="$identity" \
BACKUP_PG_BIN="$pg_bin" \
bash "$repo/ops/db-backup/openlounge-db-backup.sh" >"$missing_log" 2>&1
missing_rc=$?
set -e
(( missing_rc != 0 ))
grep -q 'backup root must be a dedicated mounted volume' "$missing_log"

log="$root/backup.log"
PGSERVICEFILE="$service_file" \
PGPASSFILE="$pass_file" \
BACKUP_PG_SERVICE=openlounge-backup-source \
BACKUP_ROOT="$backup_root" \
BACKUP_REQUIRE_MOUNT=0 \
BACKUP_AGE_RECIPIENT_FILE="$recipient" \
BACKUP_AGE_IDENTITY_FILE="$identity" \
BACKUP_PG_BIN="$pg_bin" \
BACKUP_MIN_FREE_BYTES=1 \
BACKUP_SCRATCH_PORT=55447 \
BACKUP_WEEKLY_DAY="$(date -u +%u)" \
bash "$repo/ops/db-backup/openlounge-db-backup.sh" >"$log" 2>&1

grep -Eq 'restore verification passed for [1-9][0-9]* table\(s\)' "$log"
grep -q 'backup complete: encrypted daily archive verified' "$log"
[[ $(find "$backup_root/daily" -maxdepth 1 -name '*.dump.age' -type f | wc -l) -eq 1 ]]
[[ $(find "$backup_root/weekly" -maxdepth 1 -name '*.dump.age' -type f | wc -l) -eq 1 ]]
[[ $(find "$backup_root" -type f -name '*.dump' | wc -l) -eq 0 ]]
find "$backup_root/daily" -type f -name '*.dump.age' -exec age --decrypt --identity "$identity" --output /dev/null {} \;
printf '%s\n' 'database backup integration test passed'
