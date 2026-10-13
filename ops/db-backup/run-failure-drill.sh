#!/usr/bin/env bash
# Run manually as root after an approved receiver rollout. It creates no dump and never contacts Railway.
# It proves that an incomplete receipt causes the restore-verification unit and its journal failure alert to fire.
set -Eeuo pipefail
umask 077

ENV_FILE=/etc/openlounge-backups/backup.env
[[ -r "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
BACKUP_ROOT="${BACKUP_ROOT:-/srv/openlounge-backups}"
INCOMING="${BACKUP_INCOMING_DIR:-$BACKUP_ROOT/incoming}"
USER_NAME=openlounge-backup-verify
GROUP_NAME="${BACKUP_RECEIVER_GROUP:-openlounge-backup-ingress}"
MANIFEST="$INCOMING/openlounge-20990101T000000Z-deadbeef.dump.age.manifest"
STARTED_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -d "$INCOMING" ]] || { echo "missing incoming directory: $INCOMING" >&2; exit 1; }
[[ ! -e "$MANIFEST" ]] || { echo "failure-drill manifest name already exists" >&2; exit 1; }

install -o "$USER_NAME" -g "$GROUP_NAME" -m 0640 /dev/stdin "$MANIFEST" <<'EOF'
version=2
created_utc=20990101T000000Z
source_postgres_major=18
source_db_bytes=1
format=pg_dump-custom+age
archive_file=openlounge-20990101T000000Z-deadbeef.dump.age
archive_sha256=0000000000000000000000000000000000000000000000000000000000000000
counts_file=openlounge-20990101T000000Z-deadbeef.counts.age
counts_sha256=0000000000000000000000000000000000000000000000000000000000000000
table_count=1
EOF

set +e
systemctl start openlounge-db-restore-verify.service
rc=$?
set -e
rm -f "$MANIFEST"
(( rc != 0 )) || { echo "failure drill unexpectedly succeeded" >&2; exit 1; }
systemctl is-failed --quiet openlounge-db-restore-verify.service || { echo "restore verifier is not marked failed" >&2; exit 1; }
for _ in $(seq 1 10); do
  if journalctl -t openlounge-db-restore-verify --since "$STARTED_UTC" --no-pager | grep -q 'FAILED:'; then break; fi
  sleep 1
done
journalctl -t openlounge-db-restore-verify --since "$STARTED_UTC" --no-pager | grep -q 'FAILED:' || { echo "failure alert unit did not emit its user.err journal record" >&2; exit 1; }
journalctl -u openlounge-db-restore-verify.service --since "$STARTED_UTC" --no-pager
journalctl -t openlounge-db-restore-verify --since "$STARTED_UTC" --no-pager
systemctl reset-failed openlounge-db-restore-verify.service
printf '%s\n' 'failure drill passed: incomplete receipt failed closed and logged to the journal'
