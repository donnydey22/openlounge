#!/usr/bin/env bash
# openlounge-media receiver: verifies a signed encrypted Railway receipt, restores to a scratch cluster, then retains it.
# It never connects to Railway Postgres and has no route requirement beyond Unix sockets for the scratch database.
set -Eeuo pipefail
shopt -s nullglob
umask 077

TAG="openlounge-db-restore-verify"
BACKUP_ROOT="${BACKUP_ROOT:-/srv/openlounge-backups}"
BACKUP_REQUIRE_MOUNT="${BACKUP_REQUIRE_MOUNT:-1}"
BACKUP_EXPECTED_MOUNT_SOURCE="${BACKUP_EXPECTED_MOUNT_SOURCE:-/dev/mapper/openlounge-backups}"
BACKUP_INCOMING_DIR="${BACKUP_INCOMING_DIR:-$BACKUP_ROOT/incoming}"
BACKUP_RECEIVER_GROUP="${BACKUP_RECEIVER_GROUP:-openlounge-backup-ingress}"
BACKUP_RECEIPT_STAGE_ROOT="${BACKUP_RECEIPT_STAGE_ROOT:-$BACKUP_ROOT/.receipt-stage}"
BACKUP_STATE_DIR="${BACKUP_STATE_DIR:-/var/lib/openlounge-backup-verify}"
BACKUP_AGE_IDENTITY_FILE="${BACKUP_AGE_IDENTITY_FILE:-/etc/openlounge-backups/restore-test-age-identity.txt}"
BACKUP_MANIFEST_VERIFY_KEY_FILE="${BACKUP_MANIFEST_VERIFY_KEY_FILE:-/etc/openlounge-backups/manifest-verify.pub}"
BACKUP_DAILY_KEEP="${BACKUP_DAILY_KEEP:-7}"
BACKUP_WEEKLY_KEEP="${BACKUP_WEEKLY_KEEP:-4}"
BACKUP_WEEKLY_DAY="${BACKUP_WEEKLY_DAY:-7}"
BACKUP_MIN_FREE_BYTES="${BACKUP_MIN_FREE_BYTES:-1073741824}"
BACKUP_CAPACITY_MULTIPLIER="${BACKUP_CAPACITY_MULTIPLIER:-3}"
BACKUP_CAPACITY_MARGIN_BYTES="${BACKUP_CAPACITY_MARGIN_BYTES:-1073741824}"
BACKUP_SCRATCH_PORT="${BACKUP_SCRATCH_PORT:-55442}"
BACKUP_RESTORE_TIMEOUT_SEC="${BACKUP_RESTORE_TIMEOUT_SEC:-3600}"
BACKUP_PARTIAL_MAX_AGE_SEC="${BACKUP_PARTIAL_MAX_AGE_SEC:-21600}"

log() { printf '%s %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TAG" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

committed=0
verified=0
promoted_paths=()
work_dir=""
scratch_cluster=""
scratch_socket=""
receipt_stage=""
receipt_stem=""
clean_transients() {
  set +e
  if [[ -n "$scratch_cluster" && -f "$scratch_cluster/postmaster.pid" ]]; then "$PG_CTL" -D "$scratch_cluster" -m immediate stop >/dev/null 2>&1 || true; fi
  [[ -n "$work_dir" ]] && rm -rf "$work_dir"
  [[ -n "$scratch_cluster" ]] && rm -rf "$scratch_cluster" "$scratch_socket"
  work_dir=""; scratch_cluster=""; scratch_socket=""
}
cleanup() {
  local rc=$?
  set +e
  if (( ${committed:-0} != 1 && ${verified:-0} == 1 )); then
    local qdir="$BACKUP_ROOT/quarantine/${receipt_stem:-verified-receipt}.promotion-failure"
    mkdir -p "$qdir"
    for path in "${promoted_paths[@]:-}"; do [[ -n "$path" && -e "$path" ]] && mv "$path" "$qdir/" || true; done
    [[ -n "$receipt_stage" && -d "$receipt_stage" ]] && mv "$receipt_stage" "$qdir/staged-receipt" || true
    printf 'verification_exit_status=%s\nquarantined_utc=%s\n' "$rc" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$qdir/REASON.txt"
    chmod 700 "$qdir"; chmod 600 "$qdir/REASON.txt"
    log "quarantined verified receipt after promotion failure: $qdir"
  fi
  clean_transients
  if (( rc != 0 )); then log "FAILURE: restore verification exited with status $rc"; fi
  exit "$rc"
}
trap cleanup EXIT

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

PG_RESTORE="$(resolve_bin pg_restore)"
PSQL="$(resolve_bin psql)"
INITDB="$(resolve_bin initdb)"
PG_CTL="$(resolve_bin pg_ctl)"
CREATEDB="$(resolve_bin createdb)"
AGE="$(command -v age || true)"
MINISIGN="$(command -v minisign || true)"
[[ -n "$AGE" && -n "$MINISIGN" ]] || die "age and minisign are required for restore verification"
for command in flock timeout getent stat sha256sum; do command -v "$command" >/dev/null 2>&1 || die "required command is missing: $command"; done

[[ "$BACKUP_REQUIRE_MOUNT" =~ ^[01]$ ]] || die "BACKUP_REQUIRE_MOUNT must be 0 or 1"
[[ "$BACKUP_DAILY_KEEP" =~ ^[1-9][0-9]*$ && "$BACKUP_WEEKLY_KEEP" =~ ^[1-9][0-9]*$ && "$BACKUP_WEEKLY_DAY" =~ ^[1-7]$ ]] || die "retention settings are invalid"
[[ "$BACKUP_MIN_FREE_BYTES" =~ ^[0-9]+$ && "$BACKUP_CAPACITY_MULTIPLIER" =~ ^[1-9][0-9]*$ && "$BACKUP_CAPACITY_MARGIN_BYTES" =~ ^[0-9]+$ ]] || die "capacity settings are invalid"
[[ "$BACKUP_SCRATCH_PORT" =~ ^[0-9]{2,5}$ && "$BACKUP_RESTORE_TIMEOUT_SEC" =~ ^[1-9][0-9]*$ && "$BACKUP_PARTIAL_MAX_AGE_SEC" =~ ^[6-9][0-9]*$|^[1-9][0-9]{2,}$ ]] || die "timeout settings are invalid"
getent group "$BACKUP_RECEIVER_GROUP" >/dev/null || die "backup receiver group does not exist: $BACKUP_RECEIVER_GROUP"
for file in "$BACKUP_AGE_IDENTITY_FILE" "$BACKUP_MANIFEST_VERIFY_KEY_FILE"; do [[ -f "$file" && ! -L "$file" && -r "$file" ]] || die "required key file is missing or unreadable: $file"; done
[[ -d "$BACKUP_ROOT" && -d "$BACKUP_INCOMING_DIR" && -d "$BACKUP_STATE_DIR" ]] || die "backup root, incoming directory, or state directory is missing"
if [[ "$BACKUP_REQUIRE_MOUNT" == 1 ]]; then
  mountpoint -q "$BACKUP_ROOT" || die "backup root must be the dedicated mounted LUKS volume: $BACKUP_ROOT"
  actual_mount_source="$(findmnt -n -o SOURCE --target "$BACKUP_ROOT" 2>/dev/null || true)"
  [[ "$actual_mount_source" == "$BACKUP_EXPECTED_MOUNT_SOURCE" ]] || die "backup root mount source $actual_mount_source does not match expected encrypted mapper $BACKUP_EXPECTED_MOUNT_SOURCE"
fi

mkdir -p "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly" "$BACKUP_ROOT/.tmp" "$BACKUP_ROOT/.scratch" "$BACKUP_ROOT/quarantine" "$BACKUP_RECEIPT_STAGE_ROOT"
chmod 700 "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly" "$BACKUP_ROOT/.tmp" "$BACKUP_ROOT/.scratch" "$BACKUP_ROOT/quarantine" "$BACKUP_RECEIPT_STAGE_ROOT" "$BACKUP_STATE_DIR"
exec 9>"$BACKUP_ROOT/.restore.lock"
flock -n 9 || die "another restore verification is already active"

write_counts_sql() {
  local output=$1
  cat >"$output" <<'SQL'
\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT format('SELECT %L || chr(9) || count(*)::text FROM %I.%I;', n.nspname || '.' || c.relname, n.nspname, c.relname)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p')
   AND n.nspname NOT IN ('information_schema', 'pg_catalog')
   AND n.nspname !~ '^pg_'
 ORDER BY n.nspname, c.relname;
\gexec
COMMIT;
SQL
}

require_receipt_file() {
  local file=$1 mode
  [[ -f "$file" && ! -L "$file" ]] || die "received artifact is missing or unsafe: $file"
  [[ "$(stat -c %G "$file")" == "$BACKUP_RECEIVER_GROUP" ]] || die "received artifact has an unexpected group: $file"
  mode="$(stat -c %a "$file")"
  (( (8#$mode & 7) == 0 )) || die "received artifact is readable by other users: $file"
  (( (8#$mode & 040) != 0 )) || die "received artifact is not readable by the receiver group: $file"
}

parse_manifest() {
  local file=$1 line key value
  declare -gA META=()
  require_receipt_file "$file"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == *=* ]] || die "invalid manifest line"
    key="${line%%=*}"; value="${line#*=}"
    [[ "$key" =~ ^(version|created_utc|source_postgres_major|source_db_bytes|format|archive_file|archive_sha256|counts_file|counts_sha256|table_count)$ ]] || die "unrecognized manifest key: $key"
    [[ -z "${META[$key]+x}" ]] || die "duplicate manifest key: $key"
    META[$key]="$value"
  done <"$file"
  for key in version created_utc source_postgres_major source_db_bytes format archive_file archive_sha256 counts_file counts_sha256 table_count; do [[ -n "${META[$key]:-}" ]] || die "manifest is missing $key"; done
  [[ "${META[version]}" == 2 && "${META[format]}" == "pg_dump-custom+age" ]] || die "unsupported manifest format"
  [[ "${META[created_utc]}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "manifest creation timestamp is invalid"
  [[ "${META[source_postgres_major]}" =~ ^[0-9]+$ && "${META[source_db_bytes]}" =~ ^[0-9]+$ && "${META[table_count]}" =~ ^[1-9][0-9]*$ ]] || die "manifest numeric fields are invalid"
  [[ "${META[archive_file]}" =~ ^openlounge-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}\.dump\.age$ ]] || die "manifest archive filename is invalid"
  [[ "${META[counts_file]}" == "${META[archive_file]%.dump.age}.counts.age" ]] || die "manifest counts filename does not match archive"
  [[ "${META[archive_sha256]}" =~ ^[a-f0-9]{64}$ && "${META[counts_sha256]}" =~ ^[a-f0-9]{64}$ ]] || die "manifest checksums are invalid"
}

prune_archives() {
  local dir=$1 keep=$2 path archive marker receipt
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    archive="$(basename "$path")"
    rm -f "$path" "$dir/${archive%.dump.age}.counts.age" "$dir/$archive.manifest" "$dir/$archive.manifest.minisig"
  done < <(find "$dir" -maxdepth 1 -type f -name 'openlounge-*.dump.age' -printf '%T@ %p\n' | sort -rn | awk -v keep="$keep" 'NR > keep { $1=""; sub(/^ /, ""); print }')
  if [[ "$dir" == "$BACKUP_ROOT/weekly" ]]; then
    for marker in "$dir"/.week-*; do
      [[ -f "$marker" ]] || continue
      receipt="$(cat "$marker" 2>/dev/null || true)"
      [[ -n "$receipt" && -f "$dir/$receipt" ]] || rm -f "$marker"
    done
  fi
}

cleanup_stale_partials() {
  local minutes=$(( (BACKUP_PARTIAL_MAX_AGE_SEC + 59) / 60 )) file
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    rm -f "$file"
    log "removed stale partial receipt artifact: $(basename "$file")"
  done < <(find "$BACKUP_INCOMING_DIR" -maxdepth 1 -type f -name 'openlounge-*.partial' -mmin "+$minutes" -print)
}

quarantine_receipt() {
  local manifest=$1 rc=$2 base stem qdir candidate
  base="$(basename "$manifest")"; stem="${base%.dump.age.manifest}"
  if [[ -d "$BACKUP_ROOT/quarantine/$stem.promotion-failure" ]]; then
    log "verified receipt $base was already quarantined after promotion failure"
    return
  fi
  qdir="$BACKUP_ROOT/quarantine/$(date -u +%Y%m%dT%H%M%SZ)-$stem-$RANDOM"
  mkdir -p "$qdir"; chmod 700 "$qdir"
  if [[ -d "$BACKUP_RECEIPT_STAGE_ROOT/$stem" ]]; then
    mv "$BACKUP_RECEIPT_STAGE_ROOT/$stem" "$qdir/staged-receipt"
  fi
  for candidate in "$manifest" "$BACKUP_INCOMING_DIR/$stem.dump.age" "$BACKUP_INCOMING_DIR/$stem.counts.age" "$manifest.minisig"; do
    [[ -e "$candidate" && ! -L "$candidate" ]] && mv "$candidate" "$qdir/" || true
  done
  printf 'verification_exit_status=%s\nquarantined_utc=%s\n' "$rc" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$qdir/REASON.txt"
  chmod 600 "$qdir/REASON.txt"
  log "quarantined invalid receipt $base; inspect $qdir and journal"
}

process_manifest() (
  trap cleanup EXIT
  local incoming_manifest=$1 manifest_name archive counts_archive signature run_id source_major restore_major required_bytes available_bytes
  local restore_dump source_counts restored_counts scratch_db local_source restore_sql
  committed=0; verified=0; promoted_paths=(); work_dir=""; scratch_cluster=""; scratch_socket=""; receipt_stage=""; receipt_stem=""

  manifest_name="$(basename "$incoming_manifest")"
  receipt_stem="${manifest_name%.dump.age.manifest}"
  receipt_stage="$BACKUP_RECEIPT_STAGE_ROOT/$receipt_stem"
  mkdir "$receipt_stage"; chmod 700 "$receipt_stage"
  mv "$incoming_manifest" "$receipt_stage/manifest"
  mv "$incoming_manifest.minisig" "$receipt_stage/manifest.minisig"
  manifest="$receipt_stage/manifest"
  signature="$receipt_stage/manifest.minisig"
  require_receipt_file "$manifest"
  require_receipt_file "$signature"
  "$MINISIGN" -V -q -p "$BACKUP_MANIFEST_VERIFY_KEY_FILE" -m "$manifest" -x "$signature" || die "manifest signature verification failed"
  parse_manifest "$manifest"
  [[ "$manifest_name" == "${META[archive_file]}.manifest" ]] || die "manifest filename does not match archive"
  mv "$BACKUP_INCOMING_DIR/${META[archive_file]}" "$receipt_stage/archive"
  mv "$BACKUP_INCOMING_DIR/${META[counts_file]}" "$receipt_stage/counts.age"
  archive="$receipt_stage/archive"
  counts_archive="$receipt_stage/counts.age"
  require_receipt_file "$archive"; require_receipt_file "$counts_archive"
  [[ "$(sha256sum "$archive" | awk '{print $1}')" == "${META[archive_sha256]}" ]] || die "archive checksum mismatch"
  [[ "$(sha256sum "$counts_archive" | awk '{print $1}')" == "${META[counts_sha256]}" ]] || die "count inventory checksum mismatch"
  if [[ -f "$BACKUP_STATE_DIR/last-created-utc" ]]; then
    last_created="$(cat "$BACKUP_STATE_DIR/last-created-utc")"
    [[ "$last_created" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "receiver state timestamp is invalid"
    [[ "${META[created_utc]}" > "$last_created" ]] || die "replayed or stale signed receipt"
  fi

  source_major="${META[source_postgres_major]}"
  restore_major="$($PG_RESTORE --version | sed -nE 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/p' | head -n 1)"
  [[ "$restore_major" =~ ^[0-9]+$ ]] || die "could not read pg_restore major version"
  (( restore_major >= source_major )) || die "pg_restore $restore_major is older than source PostgreSQL $source_major"
  required_bytes=$(( META[source_db_bytes] * BACKUP_CAPACITY_MULTIPLIER + BACKUP_CAPACITY_MARGIN_BYTES ))
  (( required_bytes < BACKUP_MIN_FREE_BYTES )) && required_bytes="$BACKUP_MIN_FREE_BYTES"
  available_bytes="$(df -PB1 "$BACKUP_ROOT" | awk 'END { print $4 }')"
  [[ "$available_bytes" =~ ^[0-9]+$ ]] || die "could not determine backup volume free space"
  (( available_bytes >= required_bytes )) || die "backup volume free space ${available_bytes} B is below required ${required_bytes} B"

  run_id="${META[archive_file]#openlounge-}"; run_id="${run_id%.dump.age}"
  work_dir="$BACKUP_ROOT/.tmp/verify-$run_id"; scratch_cluster="$BACKUP_ROOT/.scratch/cluster-$run_id"; scratch_socket="$BACKUP_ROOT/.scratch/socket-$run_id"
  mkdir -p "$work_dir" "$scratch_cluster" "$scratch_socket"; chmod 700 "$work_dir" "$scratch_cluster" "$scratch_socket"
  restore_dump="$work_dir/openlounge.restore.dump"; source_counts="$work_dir/source-counts.tsv"; restored_counts="$work_dir/restored-counts.tsv"
  timeout --foreground "$BACKUP_RESTORE_TIMEOUT_SEC" "$AGE" --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" --output "$restore_dump" "$archive"
  timeout --foreground "$BACKUP_RESTORE_TIMEOUT_SEC" "$AGE" --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" --output "$source_counts" "$counts_archive"
  [[ "$(wc -l <"$source_counts" | tr -d '[:space:]')" == "${META[table_count]}" ]] || die "decrypted source inventory does not match manifest"
  # Capture the full table of contents first: piping into `grep -q` lets grep exit early, pg_restore then dies of
  # EPIPE and pipefail turns a good archive into a false "no public tables" failure (FX-052).
  "$PG_RESTORE" --list "$restore_dump" >"$work_dir/toc.txt" || die "pg_restore could not list the decrypted archive"
  grep -qE 'TABLE[[:space:]].*public' "$work_dir/toc.txt" || die "decrypted archive has no public tables"

  timeout --foreground "$BACKUP_RESTORE_TIMEOUT_SEC" "$INITDB" --no-instructions --auth-local=trust --auth-host=reject --encoding=UTF8 --no-locale -D "$scratch_cluster" >/dev/null
  timeout --foreground "$BACKUP_RESTORE_TIMEOUT_SEC" "$PG_CTL" -D "$scratch_cluster" -o "-h '' -k '$scratch_socket' -p $BACKUP_SCRATCH_PORT -c dynamic_shared_memory_type=mmap" -w start >/dev/null
  scratch_db="openlounge_restore_${run_id//[^A-Za-z0-9_]/_}"
  timeout --foreground "$BACKUP_RESTORE_TIMEOUT_SEC" "$CREATEDB" --host="$scratch_socket" --port="$BACKUP_SCRATCH_PORT" "$scratch_db"
  local_source="host=$scratch_socket port=$BACKUP_SCRATCH_PORT dbname=$scratch_db"
  timeout --foreground "$BACKUP_RESTORE_TIMEOUT_SEC" "$PG_RESTORE" --exit-on-error --no-owner --no-privileges --dbname="$local_source" "$restore_dump"
  restore_sql="$work_dir/restore-counts.sql"; write_counts_sql "$restore_sql"
  timeout --foreground "$BACKUP_RESTORE_TIMEOUT_SEC" "$PSQL" "$local_source" -X -A -t -q -v ON_ERROR_STOP=1 -f "$restore_sql" | LC_ALL=C sort >"$restored_counts"
  cmp --silent "$source_counts" "$restored_counts" || { diff -u "$source_counts" "$restored_counts" >&2 || true; die "restored row counts do not match the Railway source snapshot"; }
  log "restore verification passed for ${META[table_count]} table(s) from $run_id"
  verified=1

  daily_archive="$BACKUP_ROOT/daily/${META[archive_file]}"; daily_counts="$BACKUP_ROOT/daily/${META[counts_file]}"; daily_manifest="$BACKUP_ROOT/daily/$manifest_name"; daily_signature="$daily_manifest.minisig"
  [[ ! -e "$daily_archive" && ! -e "$daily_counts" && ! -e "$daily_manifest" && ! -e "$daily_signature" ]] || die "verified archive already exists in daily retention"
  mv "$archive" "$daily_archive"; promoted_paths+=("$daily_archive")
  mv "$counts_archive" "$daily_counts"; promoted_paths+=("$daily_counts")
  mv "$signature" "$daily_signature"; promoted_paths+=("$daily_signature")
  mv "$manifest" "$daily_manifest"; promoted_paths+=("$daily_manifest")

  if [[ "$(date -u +%u)" == "$BACKUP_WEEKLY_DAY" ]]; then
    week="$(date -u +%G-W%V)"; weekly_marker="$BACKUP_ROOT/weekly/.week-$week"
    if [[ ! -e "$weekly_marker" ]]; then
      weekly_archive="$BACKUP_ROOT/weekly/${META[archive_file]}"; weekly_counts="$BACKUP_ROOT/weekly/${META[counts_file]}"; weekly_manifest="$BACKUP_ROOT/weekly/$manifest_name"; weekly_signature="$weekly_manifest.minisig"
      cp --reflink=auto --preserve=mode,timestamps "$daily_archive" "$weekly_archive"; promoted_paths+=("$weekly_archive")
      cp --reflink=auto --preserve=mode,timestamps "$daily_counts" "$weekly_counts"; promoted_paths+=("$weekly_counts")
      cp --reflink=auto --preserve=mode,timestamps "$daily_signature" "$weekly_signature"; promoted_paths+=("$weekly_signature")
      cp --reflink=auto --preserve=mode,timestamps "$daily_manifest" "$weekly_manifest"; promoted_paths+=("$weekly_manifest")
      printf '%s\n' "$(basename "$weekly_archive")" >"$weekly_marker"; chmod 600 "$weekly_marker"; promoted_paths+=("$weekly_marker")
    else
      log "weekly receipt for $week already exists; preserving prior verified copy"
    fi
  fi
  state_tmp="$BACKUP_STATE_DIR/.last-created-utc.$run_id"
  printf '%s\n' "${META[created_utc]}" >"$state_tmp"; chmod 600 "$state_tmp"; mv "$state_tmp" "$BACKUP_STATE_DIR/last-created-utc"
  rmdir "$receipt_stage"; receipt_stage=""
  committed=1
  prune_archives "$BACKUP_ROOT/daily" "$BACKUP_DAILY_KEEP"; prune_archives "$BACKUP_ROOT/weekly" "$BACKUP_WEEKLY_KEEP"
  log "backup received and retained: daily=$BACKUP_DAILY_KEEP weekly=$BACKUP_WEEKLY_KEEP"
)

cleanup_stale_partials
manifests=("$BACKUP_INCOMING_DIR"/openlounge-*.dump.age.manifest)
(( ${#manifests[@]} > 0 )) || { log "no received manifests to verify"; exit 0; }
failures=0
for manifest in "${manifests[@]}"; do
  if process_manifest "$manifest"; then :; else
    rc=$?; quarantine_receipt "$manifest" "$rc"; failures=$((failures + 1))
  fi
done
(( failures == 0 )) || die "$failures receipt(s) quarantined; see journal and $BACKUP_ROOT/quarantine"
