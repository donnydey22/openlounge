#!/usr/bin/env bash
# Scheduled Open Lounge PostgreSQL logical backup.
#
# This command is designed for the openlounge-media host. It intentionally accepts
# only a libpq service name: database credentials stay in root-managed files, never
# in the unit, command line, logs, archive names, or this repository.
set -Eeuo pipefail
umask 077

TAG="openlounge-db-backup"
BACKUP_ROOT="${BACKUP_ROOT:-/srv/openlounge-backups}"
BACKUP_REQUIRE_MOUNT="${BACKUP_REQUIRE_MOUNT:-1}"
BACKUP_PG_SERVICE="${BACKUP_PG_SERVICE:-openlounge-backup-source}"
BACKUP_AGE_RECIPIENT_FILE="${BACKUP_AGE_RECIPIENT_FILE:-/etc/openlounge-backups/age-recipients.txt}"
BACKUP_AGE_IDENTITY_FILE="${BACKUP_AGE_IDENTITY_FILE:-/etc/openlounge-backups/age-identity.txt}"
BACKUP_DAILY_KEEP="${BACKUP_DAILY_KEEP:-7}"
BACKUP_WEEKLY_KEEP="${BACKUP_WEEKLY_KEEP:-4}"
BACKUP_WEEKLY_DAY="${BACKUP_WEEKLY_DAY:-7}"
BACKUP_MIN_FREE_BYTES="${BACKUP_MIN_FREE_BYTES:-1073741824}"
BACKUP_EXPECTED_MOUNT_SOURCE="${BACKUP_EXPECTED_MOUNT_SOURCE:-/dev/mapper/openlounge-backups}"
BACKUP_CAPACITY_MULTIPLIER="${BACKUP_CAPACITY_MULTIPLIER:-3}"
BACKUP_CAPACITY_MARGIN_BYTES="${BACKUP_CAPACITY_MARGIN_BYTES:-1073741824}"
BACKUP_SCRATCH_PORT="${BACKUP_SCRATCH_PORT:-55442}"
BACKUP_SNAPSHOT_HOLD_SEC="${BACKUP_SNAPSHOT_HOLD_SEC:-1800}"
committed=0
promoted_paths=()

log() { printf '%s %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TAG" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

cleanup() {
  set +e
  if (( ${committed:-0} != 1 )); then
    for path in "${promoted_paths[@]:-}"; do
      [[ -n "$path" ]] && rm -f "$path"
    done
  fi
  if [[ -n "${snapshot_pid:-}" ]] && kill -0 "$snapshot_pid" 2>/dev/null; then
    kill "$snapshot_pid" 2>/dev/null || true
    wait "$snapshot_pid" 2>/dev/null || true
  fi
  if [[ -n "${scratch_cluster:-}" && -f "$scratch_cluster/postmaster.pid" ]]; then
    "$PG_CTL" -D "$scratch_cluster" -m immediate stop >/dev/null 2>&1 || true
  fi
  [[ -n "${plain_dump:-}" ]] && rm -f "$plain_dump"
  [[ -n "${restore_dump:-}" ]] && rm -f "$restore_dump"
  [[ -n "${archive_tmp:-}" ]] && rm -f "$archive_tmp"
  [[ -n "${snapshot_output:-}" ]] && rm -f "$snapshot_output" "${snapshot_error:-}"
  [[ -n "${source_sql:-}" ]] && rm -f "$source_sql"
  [[ -n "${restore_sql:-}" ]] && rm -f "$restore_sql"
  [[ -n "${source_counts:-}" ]] && rm -f "$source_counts"
  [[ -n "${restored_counts:-}" ]] && rm -f "$restored_counts"
  [[ -n "${scratch_cluster:-}" ]] && rm -rf "$scratch_cluster" "${scratch_socket:-}"
}

on_exit() {
  local rc=$?
  if (( rc != 0 )); then
    log "FAILURE: scheduled backup or restore verification exited with status $rc"
  fi
  cleanup
  exit "$rc"
}
trap on_exit EXIT

resolve_bin() {
  local name=$1 path
  if [[ -n "${BACKUP_PG_BIN:-}" ]]; then
    path="$BACKUP_PG_BIN/$name"
    [[ -x "$path" ]] || die "required PostgreSQL binary is not executable: $path"
    printf '%s\n' "$path"
  else
    command -v "$name" >/dev/null 2>&1 || die "required command is missing: $name"
    command -v "$name"
  fi
}

PG_DUMP="$(resolve_bin pg_dump)"
PG_RESTORE="$(resolve_bin pg_restore)"
PSQL="$(resolve_bin psql)"
INITDB="$(resolve_bin initdb)"
PG_CTL="$(resolve_bin pg_ctl)"
CREATEDB="$(resolve_bin createdb)"
AGE="$(command -v age || true)"
[[ -n "$AGE" ]] || die "age is required for encrypted backups"
command -v flock >/dev/null 2>&1 || die "flock is required to prevent overlapping backups"
command -v stdbuf >/dev/null 2>&1 || die "stdbuf is required for exported-snapshot coordination"

[[ "$BACKUP_REQUIRE_MOUNT" =~ ^[01]$ ]] || die "BACKUP_REQUIRE_MOUNT must be 0 or 1"
[[ "$BACKUP_DAILY_KEEP" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_DAILY_KEEP must be a positive integer"
[[ "$BACKUP_WEEKLY_KEEP" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_WEEKLY_KEEP must be a positive integer"
[[ "$BACKUP_WEEKLY_DAY" =~ ^[1-7]$ ]] || die "BACKUP_WEEKLY_DAY must be ISO weekday 1 through 7"
[[ "$BACKUP_MIN_FREE_BYTES" =~ ^[0-9]+$ ]] || die "BACKUP_MIN_FREE_BYTES must be a byte count"
[[ "$BACKUP_CAPACITY_MULTIPLIER" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_CAPACITY_MULTIPLIER must be a positive integer"
[[ "$BACKUP_CAPACITY_MARGIN_BYTES" =~ ^[0-9]+$ ]] || die "BACKUP_CAPACITY_MARGIN_BYTES must be a byte count"
[[ "$BACKUP_SCRATCH_PORT" =~ ^[0-9]{2,5}$ ]] || die "BACKUP_SCRATCH_PORT must be a TCP port"
[[ "$BACKUP_SNAPSHOT_HOLD_SEC" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_SNAPSHOT_HOLD_SEC must be positive"
[[ "$BACKUP_PG_SERVICE" =~ ^[A-Za-z0-9_-]+$ ]] || die "BACKUP_PG_SERVICE contains unsupported characters"

[[ -n "${PGSERVICEFILE:-}" && -f "$PGSERVICEFILE" && ! -L "$PGSERVICEFILE" && -r "$PGSERVICEFILE" ]] || die "PGSERVICEFILE must name a readable regular service file"
[[ -n "${PGPASSFILE:-}" && -f "$PGPASSFILE" && ! -L "$PGPASSFILE" && -r "$PGPASSFILE" ]] || die "PGPASSFILE must name a readable regular passfile"
[[ -f "$BACKUP_AGE_RECIPIENT_FILE" && ! -L "$BACKUP_AGE_RECIPIENT_FILE" && -r "$BACKUP_AGE_RECIPIENT_FILE" ]] || die "age recipient file is missing or unreadable"
[[ -f "$BACKUP_AGE_IDENTITY_FILE" && ! -L "$BACKUP_AGE_IDENTITY_FILE" && -r "$BACKUP_AGE_IDENTITY_FILE" ]] || die "age identity file is missing or unreadable"
[[ -d "$BACKUP_ROOT" ]] || die "backup root does not exist: $BACKUP_ROOT"
if [[ "$BACKUP_REQUIRE_MOUNT" == 1 ]]; then
  mountpoint -q "$BACKUP_ROOT" || die "backup root must be a dedicated mounted volume: $BACKUP_ROOT"
  [[ -n "$BACKUP_EXPECTED_MOUNT_SOURCE" ]] || die "BACKUP_EXPECTED_MOUNT_SOURCE is required when mount enforcement is enabled"
  actual_mount_source="$(findmnt -n -o SOURCE --target "$BACKUP_ROOT" 2>/dev/null || true)"
  [[ "$actual_mount_source" == "$BACKUP_EXPECTED_MOUNT_SOURCE" ]] || die "backup root mount source $actual_mount_source does not match expected encrypted mapper $BACKUP_EXPECTED_MOUNT_SOURCE"
fi

SOURCE="service=$BACKUP_PG_SERVICE"
server_version_num="$("$PSQL" "$SOURCE" -X -qAt -v ON_ERROR_STOP=1 -c 'SHOW server_version_num')"
[[ "$server_version_num" =~ ^[0-9]{5,6}$ ]] || die "could not read PostgreSQL server version"
server_major="${server_version_num:0:${#server_version_num}-4}"
client_major="$($PG_DUMP --version | sed -nE 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/p' | head -n 1)"
[[ "$client_major" =~ ^[0-9]+$ ]] || die "could not read pg_dump major version"
(( client_major >= server_major )) || die "pg_dump $client_major is older than source PostgreSQL $server_major; install PostgreSQL client $server_major or newer"
source_db_bytes="$("$PSQL" "$SOURCE" -X -qAt -v ON_ERROR_STOP=1 -c 'SELECT pg_database_size(current_database())')"
[[ "$source_db_bytes" =~ ^[0-9]+$ ]] || die "could not determine source PostgreSQL database size"
required_bytes=$((source_db_bytes * BACKUP_CAPACITY_MULTIPLIER + BACKUP_CAPACITY_MARGIN_BYTES))
(( required_bytes < BACKUP_MIN_FREE_BYTES )) && required_bytes="$BACKUP_MIN_FREE_BYTES"
available_bytes="$(df -PB1 "$BACKUP_ROOT" | awk 'END { print $4 }')"
[[ "$available_bytes" =~ ^[0-9]+$ ]] || die "could not determine free space for $BACKUP_ROOT"
(( available_bytes >= required_bytes )) || die "backup root free space ${available_bytes} B is below required ${required_bytes} B (source=${source_db_bytes} B, multiplier=${BACKUP_CAPACITY_MULTIPLIER}, margin=${BACKUP_CAPACITY_MARGIN_BYTES} B)"

mkdir -p "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly" "$BACKUP_ROOT/.tmp" "$BACKUP_ROOT/.scratch"
chmod 700 "$BACKUP_ROOT" "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly" "$BACKUP_ROOT/.tmp" "$BACKUP_ROOT/.scratch"
exec 9>"$BACKUP_ROOT/.backup.lock"
flock -n 9 || die "another backup run is already active"

run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
tmp_dir="$BACKUP_ROOT/.tmp/$run_id"
mkdir -p "$tmp_dir"
plain_dump="$tmp_dir/openlounge.dump"
restore_dump="$tmp_dir/openlounge.restore.dump"
archive_tmp="$tmp_dir/openlounge.dump.age"
source_counts="$tmp_dir/source-counts.tsv"
restored_counts="$tmp_dir/restored-counts.tsv"

snapshot_output="$tmp_dir/snapshot.out"
snapshot_error="$tmp_dir/snapshot.err"
stdbuf -oL "$PSQL" "$SOURCE" -X -A -t -q -v ON_ERROR_STOP=1 >"$snapshot_output" 2>"$snapshot_error" <<SQL &
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_export_snapshot();
SELECT pg_sleep($BACKUP_SNAPSHOT_HOLD_SEC);
SQL
snapshot_pid=$!
snapshot=""
for _ in $(seq 1 300); do
  snapshot="$(awk 'NF { print; exit }' "$snapshot_output" 2>/dev/null || true)"
  if [[ "$snapshot" =~ ^[0-9A-Fa-f-]+$ ]]; then break; fi
  if ! kill -0 "$snapshot_pid" 2>/dev/null; then
    cat "$snapshot_error" >&2 || true
    die "could not export a source snapshot"
  fi
  sleep 0.1
done
[[ "$snapshot" =~ ^[0-9A-Fa-f-]+$ ]] || die "timed out waiting for source snapshot export"

write_counts_sql() {
  local output=$1 snapshot_name=${2:-}
  cat >"$output" <<SQL
\\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
${snapshot_name:+SET TRANSACTION SNAPSHOT '$snapshot_name';}
SELECT format('SELECT %L || chr(9) || count(*)::text FROM %I.%I;', n.nspname || '.' || c.relname, n.nspname, c.relname)
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p')
   AND n.nspname NOT IN ('information_schema', 'pg_catalog')
   AND n.nspname !~ '^pg_'
 ORDER BY n.nspname, c.relname;
\\gexec
COMMIT;
SQL
}

source_sql="$tmp_dir/source-counts.sql"
write_counts_sql "$source_sql" "$snapshot"
"$PSQL" "$SOURCE" -X -A -t -q -v ON_ERROR_STOP=1 -f "$source_sql" | LC_ALL=C sort >"$source_counts"
[[ -s "$source_counts" ]] || die "source table-count inventory is empty"

log "dumping PostgreSQL $server_major using a consistent exported snapshot"
"$PG_DUMP" "$SOURCE" --snapshot="$snapshot" --format=custom --compress=6 --no-owner --no-privileges --file="$plain_dump"
"$PG_RESTORE" --list "$plain_dump" | grep -qE 'TABLE[[:space:]].*public' || die "logical archive has no public tables"

kill "$snapshot_pid" 2>/dev/null || true
wait "$snapshot_pid" 2>/dev/null || true
unset snapshot_pid

"$AGE" --encrypt --recipients-file "$BACKUP_AGE_RECIPIENT_FILE" --output "$archive_tmp" "$plain_dump"
"$AGE" --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" --output "$restore_dump" "$archive_tmp"
"$PG_RESTORE" --list "$restore_dump" | grep -qE 'TABLE[[:space:]].*public' || die "decrypted archive has no public tables"

scratch_cluster="$BACKUP_ROOT/.scratch/cluster-$run_id"
scratch_socket="$BACKUP_ROOT/.scratch/socket-$run_id"
mkdir -p "$scratch_cluster" "$scratch_socket"
chmod 700 "$scratch_cluster" "$scratch_socket"
"$INITDB" --no-instructions --auth-local=trust --auth-host=reject --encoding=UTF8 --no-locale -D "$scratch_cluster" >/dev/null
"$PG_CTL" -D "$scratch_cluster" -o "-h '' -k '$scratch_socket' -p $BACKUP_SCRATCH_PORT -c dynamic_shared_memory_type=mmap" -w start >/dev/null
scratch_db="openlounge_restore_${run_id//[^A-Za-z0-9_]/_}"
"$CREATEDB" --host="$scratch_socket" --port="$BACKUP_SCRATCH_PORT" "$scratch_db"
LOCAL_SOURCE="host=$scratch_socket port=$BACKUP_SCRATCH_PORT dbname=$scratch_db"
"$PG_RESTORE" --exit-on-error --no-owner --no-privileges --dbname="$LOCAL_SOURCE" "$restore_dump"
restore_sql="$tmp_dir/restore-counts.sql"
write_counts_sql "$restore_sql"
"$PSQL" "$LOCAL_SOURCE" -X -A -t -q -v ON_ERROR_STOP=1 -f "$restore_sql" | LC_ALL=C sort >"$restored_counts"
cmp --silent "$source_counts" "$restored_counts" || {
  diff -u "$source_counts" "$restored_counts" >&2 || true
  die "restored row counts do not match the source snapshot"
}
log "restore verification passed for $(wc -l <"$source_counts") table(s)"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$BACKUP_ROOT/daily/openlounge-$stamp.dump.age"
manifest="$archive.manifest"
daily_stage="$tmp_dir/daily.dump.age"
manifest_stage="$tmp_dir/daily.dump.age.manifest"
mv "$archive_tmp" "$daily_stage"
archive_tmp=""
{
  printf 'created_utc=%s\n' "$stamp"
  printf 'source_postgres_major=%s\n' "$server_major"
  printf 'format=pg_dump-custom+age\n'
  printf 'archive_sha256=%s\n' "$(sha256sum "$daily_stage" | awk '{print $1}')"
  printf 'table_counts_sha256=%s\n' "$(sha256sum "$source_counts" | awk '{print $1}')"
  printf 'table_count=%s\n' "$(wc -l <"$source_counts")"
} >"$manifest_stage"
chmod 600 "$daily_stage" "$manifest_stage"

if [[ "$(date -u +%u)" == "$BACKUP_WEEKLY_DAY" ]]; then
  week="$(date -u +%G-W%V)"
  weekly_archive="$BACKUP_ROOT/weekly/openlounge-$week.dump.age"
  if [[ ! -e "$weekly_archive" && ! -e "$weekly_archive.manifest" ]]; then
    weekly_stage="$tmp_dir/weekly.dump.age"
    weekly_manifest_stage="$tmp_dir/weekly.dump.age.manifest"
    cp --reflink=auto --preserve=mode "$daily_stage" "$weekly_stage"
    cp --reflink=auto --preserve=mode "$manifest_stage" "$weekly_manifest_stage"
  else
    log "weekly archive for $week already exists; preserving the prior verified copy"
  fi
fi

mv "$daily_stage" "$archive"
promoted_paths+=("$archive")
mv "$manifest_stage" "$manifest"
promoted_paths+=("$manifest")
if [[ -n "${weekly_stage:-}" ]]; then
  mv "$weekly_stage" "$weekly_archive"
  promoted_paths+=("$weekly_archive")
  mv "$weekly_manifest_stage" "$weekly_archive.manifest"
  promoted_paths+=("$weekly_archive.manifest")
fi
committed=1

prune_archives() {
  local dir=$1 keep=$2 path name
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    name="$(basename "$path")"
    rm -f "$path" "$dir/$name.manifest"
  done < <(find "$dir" -maxdepth 1 -type f -name 'openlounge-*.dump.age' -printf '%T@ %p\n' | sort -rn | awk -v keep="$keep" 'NR > keep { $1=""; sub(/^ /, ""); print }')
}
prune_archives "$BACKUP_ROOT/daily" "$BACKUP_DAILY_KEEP"
prune_archives "$BACKUP_ROOT/weekly" "$BACKUP_WEEKLY_KEEP"

log "backup complete: encrypted daily archive verified; retained daily=$BACKUP_DAILY_KEEP weekly=$BACKUP_WEEKLY_KEEP"
