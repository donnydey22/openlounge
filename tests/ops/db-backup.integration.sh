#!/usr/bin/env bash
# Local-only integration test: private-DNS exporter -> signed/encrypted fake SFTP receipt -> droplet restore verifier.
# It never reaches Railway, DigitalOcean, a public database endpoint, or a production SSH server.
set -Eeuo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
pg_bin="${BACKUP_TEST_PG_BIN:-/usr/lib/postgresql/16/bin}"
for command in initdb pg_ctl createdb psql pg_dump pg_restore; do [[ -x "$pg_bin/$command" ]] || { echo "missing $pg_bin/$command" >&2; exit 77; }; done
for command in age minisign ssh-keygen sudo; do command -v "$command" >/dev/null || { echo "missing $command" >&2; exit 77; }; done

root=$(mktemp -d /tmp/openlounge-railway-backup-test.XXXXXX)
source_data="$root/source-data"; source_socket="$root/source-socket"; backup_root="$root/backups"; incoming="$backup_root/incoming"; state_dir="$root/state"
port=55448
marker="# openlounge-db-backup-integration"
cleanup() {
  local rc=$?
  if (( rc != 0 )) && [[ -f "${log:-}" ]]; then printf '%s\n' '--- backup integration log ---' >&2; cat "$log" >&2 || true; fi
  "$pg_bin/pg_ctl" -D "$source_data" -m immediate stop >/dev/null 2>&1 || true
  sudo sed -i "\\|$marker|d" /etc/hosts || true
  rm -rf "$root"
  exit "$rc"
}
trap cleanup EXIT

mkdir -p "$source_socket" "$incoming" "$backup_root/daily" "$backup_root/weekly" "$state_dir"
"$pg_bin/initdb" --no-instructions --auth-local=trust --auth-host=trust --encoding=UTF8 --no-locale -D "$source_data" >/dev/null
"$pg_bin/pg_ctl" -D "$source_data" -o "-h 127.0.0.1 -k '$source_socket' -p $port" -w start >/dev/null
"$pg_bin/createdb" --host=127.0.0.1 --port="$port" backup_source
"$pg_bin/psql" "host=127.0.0.1 port=$port dbname=backup_source" -X -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL);
CREATE TABLE dms (id integer PRIMARY KEY, body text NOT NULL);
INSERT INTO users VALUES (1, 'one'), (2, 'two'), (3, 'three');
INSERT INTO dms VALUES (10, 'hello'), (11, 'backup');
CREATE ROLE openlounge_backup_ro LOGIN INHERIT PASSWORD 'backup-test-pass' CONNECTION LIMIT 4;
GRANT CONNECT ON DATABASE backup_source TO openlounge_backup_ro;
GRANT pg_read_all_data TO openlounge_backup_ro;
SQL

# Production code only accepts the private Railway hostname. Map it to this disposable source for the local test.
sudo sed -i "\\|$marker|d" /etc/hosts
printf '127.0.0.1 postgres.railway.internal %s\n' "$marker" | sudo tee -a /etc/hosts >/dev/null

restore_identity="$root/restore-test-age-identity.txt"; restore_recipient="$root/restore-test-age-recipient.txt"
age-keygen -o "$restore_identity" >/dev/null 2>&1
age-keygen -y "$restore_identity" >"$restore_recipient"
signing_key="$root/manifest-signing.key"; verify_key="$root/manifest-verify.pub"
minisign -G -W -s "$signing_key" -p "$verify_key" >/dev/null 2>&1
ssh_key="$root/sftp-key"; host_key="$root/sftp-host-key"
ssh-keygen -q -t ed25519 -N '' -f "$ssh_key"
ssh-keygen -q -t ed25519 -N '' -f "$host_key"
known_hosts="165.232.137.71 $(cat "$host_key.pub")"

# Fake SFTP deliberately supports only the uploader's fixed upload/rename batch; it simulates server umask 0007.
fakebin="$root/fakebin"; mkdir -p "$fakebin"
cat >"$fakebin/sftp" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${FAKE_SFTP_ROOT:-}" ]] || exit 2
batch=$(mktemp); trap 'rm -f "$batch"' EXIT; cat >"$batch"
dir=""
while read -r op a b; do
  case "$op" in
    cd) [[ "$a" == incoming ]]; dir="$FAKE_SFTP_ROOT" ;;
    put) [[ -n "$dir" && "$b" =~ ^openlounge-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}\.(dump\.age|counts\.age|dump\.age\.manifest|dump\.age\.manifest\.minisig)(\.partial)?$ ]]; cp -- "$a" "$dir/$b"; chmod 640 "$dir/$b" ;;
    rename) [[ -n "$dir" ]]; mv -- "$dir/$a" "$dir/$b" ;;
    *) exit 3 ;;
  esac
done <"$batch"
EOF
chmod 755 "$fakebin/sftp"

exporter() {
  PATH="$fakebin:$PATH" FAKE_SFTP_ROOT="$incoming" BACKUP_TEST_MODE=1 \
  BACKUP_PGHOST=postgres.railway.internal BACKUP_PGPORT="$port" BACKUP_PGDATABASE=backup_source \
  BACKUP_PGUSER=openlounge_backup_ro BACKUP_PGPASSWORD=backup-test-pass BACKUP_PGSSLMODE=disable \
  BACKUP_AGE_RESTORE_RECIPIENT="$(cat "$restore_recipient")" BACKUP_MANIFEST_SIGNING_KEY="$(cat "$signing_key")" \
  BACKUP_SSH_PRIVATE_KEY="$(cat "$ssh_key")" BACKUP_SSH_KNOWN_HOSTS="$known_hosts" \
  BACKUP_EXPORT_TIMEOUT_SEC=10 BACKUP_SNAPSHOT_HOLD_SEC=20 BACKUP_SFTP_TIMEOUT_SEC=10 \
  bash "$repo/ops/db-backup/railway/export-backup.sh"
}
receiver() {
  BACKUP_ROOT="$backup_root" BACKUP_REQUIRE_MOUNT=0 BACKUP_RECEIVER_GROUP="$(id -gn)" BACKUP_STATE_DIR="$state_dir" \
  BACKUP_AGE_IDENTITY_FILE="$restore_identity" BACKUP_MANIFEST_VERIFY_KEY_FILE="$verify_key" BACKUP_PG_BIN="$pg_bin" \
  BACKUP_MIN_FREE_BYTES=1 BACKUP_SCRATCH_PORT=55449 BACKUP_WEEKLY_DAY="$(date -u +%u)" BACKUP_RESTORE_TIMEOUT_SEC=30 BACKUP_PARTIAL_MAX_AGE_SEC=60 \
  bash "$repo/ops/db-backup/openlounge-db-restore-verify.sh"
}

missing_log="$root/missing-mount.log"
set +e
BACKUP_ROOT="$root/not-mounted" BACKUP_REQUIRE_MOUNT=1 BACKUP_RECEIVER_GROUP="$(id -gn)" BACKUP_STATE_DIR="$state_dir" BACKUP_AGE_IDENTITY_FILE="$restore_identity" BACKUP_MANIFEST_VERIFY_KEY_FILE="$verify_key" BACKUP_PG_BIN="$pg_bin" \
  bash "$repo/ops/db-backup/openlounge-db-restore-verify.sh" >"$missing_log" 2>&1
missing_rc=$?
set -e
(( missing_rc != 0 ))
grep -q 'backup root, incoming directory, or state directory is missing\|backup root must be the dedicated mounted LUKS volume' "$missing_log"

log="$root/run.log"
exporter >"$log" 2>&1
grep -q 'signed encrypted dump and inventory uploaded' "$log"
[[ $(find "$incoming" -maxdepth 1 -type f -name '*.dump.age' | wc -l) -eq 1 ]]
[[ $(find "$incoming" -maxdepth 1 -type f -name '*.counts.age' | wc -l) -eq 1 ]]
[[ $(find "$incoming" -maxdepth 1 -type f -name '*.manifest' | wc -l) -eq 1 ]]
[[ $(find "$incoming" -maxdepth 1 -type f -name '*.minisig' | wc -l) -eq 1 ]]
receiver >>"$log" 2>&1
grep -Eq 'restore verification passed for [1-9][0-9]* table\(s\)' "$log"
grep -q 'backup received and retained: daily=7 weekly=4' "$log"
[[ $(find "$backup_root/daily" -maxdepth 1 -type f -name '*.dump.age' | wc -l) -eq 1 ]]
[[ $(find "$backup_root/daily" -maxdepth 1 -type f -name '*.counts.age' | wc -l) -eq 1 ]]
[[ $(find "$backup_root/daily" -maxdepth 1 -type f -name '*.manifest' | wc -l) -eq 1 ]]
[[ $(find "$backup_root/daily" -maxdepth 1 -type f -name '*.minisig' | wc -l) -eq 1 ]]
[[ $(find "$backup_root/weekly" -maxdepth 1 -type f -name '*.dump.age' | wc -l) -eq 1 ]]
weekly_archive="$(find "$backup_root/weekly" -maxdepth 1 -type f -name '*.dump.age' -print -quit)"
weekly_manifest="$backup_root/weekly/$(basename "$weekly_archive").manifest"
minisign -V -q -p "$verify_key" -m "$weekly_manifest" -x "$weekly_manifest.minisig"
[[ $(find "$incoming" -maxdepth 1 -type f | wc -l) -eq 0 ]]
[[ $(find "$backup_root" -type f -name '*.dump' | wc -l) -eq 0 ]]

# A validly signed receipt with a changed manifest must be quarantined before any decrypt/restore.
daily_manifest="$(find "$backup_root/daily" -maxdepth 1 -type f -name '*.manifest' -print -quit)"
tampered="$incoming/$(basename "$daily_manifest")"
cp "$daily_manifest" "$tampered"; cp "$daily_manifest.minisig" "$tampered.minisig"; chmod 640 "$tampered" "$tampered.minisig"
sed -i 's/^source_db_bytes=.*/source_db_bytes=999999/' "$tampered"
sleep 1
exporter >>"$log" 2>&1
set +e
receiver >>"$log" 2>&1
mixed_rc=$?
set -e
(( mixed_rc != 0 ))
grep -q 'manifest signature verification failed' "$log"
[[ $(find "$backup_root/quarantine" -type f -name 'REASON.txt' | wc -l) -ge 1 ]]
[[ $(find "$backup_root/daily" -maxdepth 1 -type f -name '*.dump.age' | wc -l) -eq 2 ]]
# The valid later receipt was processed despite the earlier malformed one; a clean invocation catches up without a path event.
receiver >>"$log" 2>&1

# Stale interrupted uploads are bounded and removed without accepting them as a receipt.
partial="$incoming/openlounge-20000101T000000Z-deadbeef.dump.age.partial"
: >"$partial"; chmod 640 "$partial"; touch -d '2 hours ago' "$partial"
receiver >>"$log" 2>&1
[[ ! -e "$partial" ]]

find "$backup_root/daily" -type f -name '*.dump.age' -exec age --decrypt --identity "$restore_identity" --output /dev/null {} \;
find "$backup_root/daily" -type f -name '*.counts.age' -exec age --decrypt --identity "$restore_identity" --output /dev/null {} \;
printf '%s\n' 'Railway private signed export, encrypted receipt, restore verification, quarantine, retention, and stale-partial recovery passed'
