#!/usr/bin/env bash
# One-shot Railway Cron exporter for Open Lounge PostgreSQL.
# Runs only inside the Railway project: private Postgres, read-only role, encrypted/signed artifacts, pinned SFTP.
set -Eeuo pipefail
umask 077

TAG="openlounge-railway-backup"
RECOVERY_RECIPIENT="age1nnl9tv0w5tjk3kttljyflzllrhna99l6jnzt5dw5ctuhefz2n3gqcel5j2"
PRIVATE_POSTGRES_HOST="postgres.railway.internal"
SFTP_TARGET="${BACKUP_SFTP_TARGET:-openlounge-backup@165.232.137.71}"
SFTP_REMOTE_DIR="${BACKUP_SFTP_REMOTE_DIR:-incoming}"
BACKUP_PGHOST="${BACKUP_PGHOST:-$PRIVATE_POSTGRES_HOST}"
BACKUP_PGPORT="${BACKUP_PGPORT:-5432}"
BACKUP_PGSSLMODE="${BACKUP_PGSSLMODE:-verify-full}"
BACKUP_CONNECT_TIMEOUT_SEC="${BACKUP_CONNECT_TIMEOUT_SEC:-20}"
BACKUP_EXPORT_TIMEOUT_SEC="${BACKUP_EXPORT_TIMEOUT_SEC:-3600}"
BACKUP_SNAPSHOT_HOLD_SEC="${BACKUP_SNAPSHOT_HOLD_SEC:-3900}"
BACKUP_SFTP_TIMEOUT_SEC="${BACKUP_SFTP_TIMEOUT_SEC:-600}"

log() { printf '%s %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TAG" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

work_dir=""
snapshot_pid=""
counts_pid=""
dump_pid=""
cleanup() {
  local rc=$?
  set +e
  for pid in "${counts_pid:-}" "${dump_pid:-}" "${snapshot_pid:-}"; do
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && kill "$pid" 2>/dev/null || true
  done
  for pid in "${counts_pid:-}" "${dump_pid:-}" "${snapshot_pid:-}"; do
    [[ -n "$pid" ]] && wait "$pid" 2>/dev/null || true
  done
  [[ -n "$work_dir" ]] && rm -rf "$work_dir"
  unset PGPASSWORD BACKUP_PGPASSWORD BACKUP_SSH_PRIVATE_KEY BACKUP_MANIFEST_SIGNING_KEY BACKUP_PGSSLROOTCERT_PEM
  if (( rc != 0 )); then log "FAILURE: Railway backup export stopped with status $rc"; fi
  exit "$rc"
}
trap cleanup EXIT

for command in pg_dump pg_restore psql age minisign sftp ssh-keygen sha256sum flock stdbuf timeout; do
  command -v "$command" >/dev/null 2>&1 || die "required command is missing: $command"
done

[[ "$BACKUP_PGHOST" == "$PRIVATE_POSTGRES_HOST" ]] || die "BACKUP_PGHOST must remain Railway-private ($PRIVATE_POSTGRES_HOST)"
[[ "$BACKUP_PGPORT" =~ ^[0-9]{2,5}$ ]] || die "BACKUP_PGPORT must be a TCP port"
[[ "$BACKUP_CONNECT_TIMEOUT_SEC" =~ ^[1-9][0-9]*$ && "$BACKUP_EXPORT_TIMEOUT_SEC" =~ ^[1-9][0-9]*$ && "$BACKUP_SNAPSHOT_HOLD_SEC" =~ ^[1-9][0-9]*$ && "$BACKUP_SFTP_TIMEOUT_SEC" =~ ^[1-9][0-9]*$ ]] || die "backup timeouts must be positive seconds"
(( BACKUP_SNAPSHOT_HOLD_SEC > BACKUP_EXPORT_TIMEOUT_SEC )) || die "BACKUP_SNAPSHOT_HOLD_SEC must exceed BACKUP_EXPORT_TIMEOUT_SEC"
[[ "$SFTP_TARGET" == "openlounge-backup@165.232.137.71" ]] || die "BACKUP_SFTP_TARGET is fixed to the restricted media-host receiver"
[[ "$SFTP_REMOTE_DIR" =~ ^[A-Za-z0-9._-]+$ ]] || die "BACKUP_SFTP_REMOTE_DIR contains unsupported characters"
[[ -n "${BACKUP_PGDATABASE:-}" && "${BACKUP_PGDATABASE:-}" =~ ^[A-Za-z0-9_-]+$ ]] || die "BACKUP_PGDATABASE is required and must contain supported characters"
[[ "${BACKUP_PGUSER:-}" == "openlounge_backup_ro" ]] || die "BACKUP_PGUSER must be the dedicated openlounge_backup_ro role"
[[ -n "${BACKUP_PGPASSWORD:-}" ]] || die "BACKUP_PGPASSWORD is required"
[[ "${BACKUP_AGE_RESTORE_RECIPIENT:-}" =~ ^age1[ac-hj-np-z02-9]+$ ]] || die "BACKUP_AGE_RESTORE_RECIPIENT must be the separate age public restore-test key"
[[ -n "${BACKUP_SSH_PRIVATE_KEY:-}" && -n "${BACKUP_SSH_KNOWN_HOSTS:-}" ]] || die "restricted SFTP key and pinned known_hosts are required"
[[ -n "${BACKUP_MANIFEST_SIGNING_KEY:-}" ]] || die "BACKUP_MANIFEST_SIGNING_KEY is required"

if [[ "${BACKUP_TEST_MODE:-}" == 1 && "$BACKUP_PGSSLMODE" == "disable" ]]; then
  : # Disposable test-only local Postgres path.
else
  [[ "$BACKUP_PGSSLMODE" == "verify-full" ]] || die "BACKUP_PGSSLMODE must be verify-full outside BACKUP_TEST_MODE"
  [[ -n "${BACKUP_PGSSLROOTCERT_PEM:-}" ]] || die "BACKUP_PGSSLROOTCERT_PEM is required for authenticated PostgreSQL TLS"
fi

work_dir="$(mktemp -d /tmp/openlounge-railway-backup.XXXXXX)"
chmod 700 "$work_dir"
ssh_key="$work_dir/sftp_key"
known_hosts="$work_dir/known_hosts"
signing_key="$work_dir/manifest-signing.key"
ssl_root="$work_dir/railway-postgres-ca.pem"
printf '%s\n' "$BACKUP_SSH_PRIVATE_KEY" >"$ssh_key"
printf '%s\n' "$BACKUP_SSH_KNOWN_HOSTS" >"$known_hosts"
printf '%s\n' "$BACKUP_MANIFEST_SIGNING_KEY" >"$signing_key"
unset BACKUP_SSH_PRIVATE_KEY BACKUP_SSH_KNOWN_HOSTS BACKUP_MANIFEST_SIGNING_KEY
chmod 600 "$ssh_key" "$known_hosts" "$signing_key"
ssh-keygen -y -f "$ssh_key" >/dev/null 2>&1 || die "BACKUP_SSH_PRIVATE_KEY is not a usable private key"
ssh-keygen -F 165.232.137.71 -f "$known_hosts" >/dev/null 2>&1 || die "BACKUP_SSH_KNOWN_HOSTS must pin 165.232.137.71"

if [[ "${BACKUP_TEST_MODE:-}" != 1 ]]; then
  printf '%s\n' "$BACKUP_PGSSLROOTCERT_PEM" >"$ssl_root"
  unset BACKUP_PGSSLROOTCERT_PEM
  chmod 600 "$ssl_root"
  export PGSSLROOTCERT="$ssl_root"
fi

# libpq sees only sealed Railway variables. The application DATABASE_URL is deliberately never read.
export PGHOST="$BACKUP_PGHOST" PGPORT="$BACKUP_PGPORT" PGDATABASE="$BACKUP_PGDATABASE" PGUSER="$BACKUP_PGUSER" PGPASSWORD="$BACKUP_PGPASSWORD" PGSSLMODE="$BACKUP_PGSSLMODE" PGCONNECT_TIMEOUT="$BACKUP_CONNECT_TIMEOUT_SEC"
unset BACKUP_PGPASSWORD

server_version_num="$(timeout --foreground "$BACKUP_CONNECT_TIMEOUT_SEC" psql -X -qAt -v ON_ERROR_STOP=1 -c 'SHOW server_version_num')"
[[ "$server_version_num" =~ ^[0-9]{5,6}$ ]] || die "could not read PostgreSQL server version"
server_major="${server_version_num:0:${#server_version_num}-4}"
client_major="$(pg_dump --version | sed -nE 's/.* ([0-9]+)(\.[0-9]+)?.*/\1/p' | head -n 1)"
[[ "$client_major" =~ ^[0-9]+$ ]] || die "could not read pg_dump major version"
(( client_major >= server_major )) || die "pg_dump $client_major is older than PostgreSQL $server_major"
source_db_bytes="$(timeout --foreground "$BACKUP_CONNECT_TIMEOUT_SEC" psql -X -qAt -v ON_ERROR_STOP=1 -c 'SELECT pg_database_size(current_database())')"
[[ "$source_db_bytes" =~ ^[0-9]+$ ]] || die "could not determine source database size"

# A read-only backup must never silently bypass RLS and produce a partial archive.
rls_tables="$(timeout --foreground "$BACKUP_CONNECT_TIMEOUT_SEC" psql -X -qAt -v ON_ERROR_STOP=1 -c "SELECT n.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND c.relrowsecurity AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1")"
[[ -z "$rls_tables" ]] || die "row-level security is enabled on application tables; backup role must be reviewed before export"

run_id="$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx4 /dev/urandom | tr -d '[:space:]')"
archive_name="openlounge-$run_id.dump.age"
counts_name="openlounge-$run_id.counts.age"
manifest_name="$archive_name.manifest"
signature_name="$manifest_name.minisig"
plain_dump="$work_dir/openlounge.dump"
plain_counts="$work_dir/source-counts.tsv"
archive="$work_dir/$archive_name"
counts_archive="$work_dir/$counts_name"
manifest="$work_dir/$manifest_name"
signature="$work_dir/$signature_name"
snapshot_output="$work_dir/snapshot.out"
snapshot_error="$work_dir/snapshot.err"

# The holder stays open only while two bounded consumers import the exported snapshot in parallel.
stdbuf -oL psql -X -A -t -q -v ON_ERROR_STOP=1 >"$snapshot_output" 2>"$snapshot_error" <<SQL &
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_export_snapshot();
SELECT pg_sleep($BACKUP_SNAPSHOT_HOLD_SEC);
SQL
snapshot_pid=$!
snapshot=""
for _ in $(seq 1 "$BACKUP_CONNECT_TIMEOUT_SEC"0); do
  snapshot="$(awk 'NF { print; exit }' "$snapshot_output" 2>/dev/null || true)"
  [[ "$snapshot" =~ ^[0-9A-Fa-f-]+$ ]] && break
  if ! kill -0 "$snapshot_pid" 2>/dev/null; then cat "$snapshot_error" >&2 || true; die "could not export a Railway Postgres snapshot"; fi
  sleep 0.1
done
[[ "$snapshot" =~ ^[0-9A-Fa-f-]+$ ]] || die "timed out waiting for source snapshot export"

counts_sql="$work_dir/source-counts.sql"
cat >"$counts_sql" <<SQL
\\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT '$snapshot';
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
log "exporting a consistent PostgreSQL $server_major snapshot with bounded parallel inventory and pg_dump consumers"
(timeout --foreground "$BACKUP_EXPORT_TIMEOUT_SEC" psql -X -A -t -q -v ON_ERROR_STOP=1 -f "$counts_sql" | LC_ALL=C sort >"$plain_counts") &
counts_pid=$!
(timeout --foreground "$BACKUP_EXPORT_TIMEOUT_SEC" pg_dump --snapshot="$snapshot" --format=custom --compress=6 --no-owner --no-privileges --file="$plain_dump") &
dump_pid=$!
wait "$counts_pid" || die "source row-count inventory failed or exceeded BACKUP_EXPORT_TIMEOUT_SEC"
counts_pid=""
wait "$dump_pid" || die "pg_dump failed or exceeded BACKUP_EXPORT_TIMEOUT_SEC"
dump_pid=""
[[ -s "$plain_counts" ]] || die "source table-count inventory is empty"
source_table_count="$(wc -l <"$plain_counts" | tr -d '[:space:]')"
[[ "$source_table_count" =~ ^[1-9][0-9]*$ ]] || die "could not count source table inventory"
pg_restore --list "$plain_dump" | grep -qE 'TABLE[[:space:]].*public' || die "logical archive has no public tables"
kill "$snapshot_pid" 2>/dev/null || true
wait "$snapshot_pid" 2>/dev/null || true
snapshot_pid=""

# Encrypt both payloads to recovery + restore-test public keys before network transfer.
age --encrypt --recipient "$RECOVERY_RECIPIENT" --recipient "$BACKUP_AGE_RESTORE_RECIPIENT" --output "$archive" "$plain_dump"
age --encrypt --recipient "$RECOVERY_RECIPIENT" --recipient "$BACKUP_AGE_RESTORE_RECIPIENT" --output "$counts_archive" "$plain_counts"
rm -f "$plain_dump" "$plain_counts"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
{
  printf 'version=2\n'
  printf 'created_utc=%s\n' "$stamp"
  printf 'source_postgres_major=%s\n' "$server_major"
  printf 'source_db_bytes=%s\n' "$source_db_bytes"
  printf 'format=pg_dump-custom+age\n'
  printf 'archive_file=%s\n' "$archive_name"
  printf 'archive_sha256=%s\n' "$(sha256sum "$archive" | awk '{print $1}')"
  printf 'counts_file=%s\n' "$counts_name"
  printf 'counts_sha256=%s\n' "$(sha256sum "$counts_archive" | awk '{print $1}')"
  printf 'table_count=%s\n' "$source_table_count"
} >"$manifest"
minisign -S -s "$signing_key" -m "$manifest" -x "$signature" >/dev/null
chmod 600 "$archive" "$counts_archive" "$manifest" "$signature"

# Encrypted payloads and signature arrive first; the signed manifest is published last.
timeout --foreground "$BACKUP_SFTP_TIMEOUT_SEC" sftp -q -b - \
  -oBatchMode=yes -oIdentitiesOnly=yes -oClearAllForwardings=yes \
  -oStrictHostKeyChecking=yes -oUserKnownHostsFile="$known_hosts" \
  -oConnectTimeout=15 -oServerAliveInterval=10 -oServerAliveCountMax=3 \
  -i "$ssh_key" "$SFTP_TARGET" <<SFTP
cd $SFTP_REMOTE_DIR
put $archive $archive_name.partial
rename $archive_name.partial $archive_name
put $counts_archive $counts_name.partial
rename $counts_name.partial $counts_name
put $signature $signature_name.partial
rename $signature_name.partial $signature_name
put $manifest $manifest_name.partial
rename $manifest_name.partial $manifest_name
SFTP

log "export complete: signed encrypted dump and inventory uploaded to the restricted media-host receiver"
