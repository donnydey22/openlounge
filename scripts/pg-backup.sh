#!/usr/bin/env bash
# Logical backup of the Open Lounge Postgres database (pg_dump custom format, compressed).
#
#   DATABASE_URL=postgresql://... scripts/pg-backup.sh [out_dir]          # default out_dir: ./backups
#
# This is a manual developer helper, not the production backup path. It deliberately does not
# read DATABASE_PUBLIC_URL; production uses the private Railway Cron exporter in ops/db-backup/railway/.
# Railway Postgres runs PG 18: pg_dump must be >= the server major version (pg_dump 17 refuses an 18 server).
# If the local pg_dump is too old the script falls back to the postgres:18 Docker image when Docker is available.
# Restore:  pg_restore --clean --if-exists --no-owner -d "$TARGET_URL" backups/openlounge-<ts>.dump
# Retention: KEEP (default 14) newest dumps are kept in out_dir.
set -euo pipefail
URL="${DATABASE_URL:-}"
[ -n "$URL" ] || { echo "set DATABASE_URL from an approved private environment" >&2; exit 2; }
OUT="${1:-backups}"
KEEP="${KEEP:-14}"
mkdir -p "$OUT"
chmod 700 "$OUT"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT/openlounge-$TS.dump"
server_major="$(psql "$URL" -Atc 'SHOW server_version_num' | cut -c1-2)"
local_major="$(pg_dump --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo 0)"
if [ "${local_major:-0}" -ge "$server_major" ]; then
  pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="$FILE" "$URL"
elif command -v docker >/dev/null; then
  echo "local pg_dump $local_major < server $server_major — using docker postgres:$server_major" >&2
  docker run --rm --network host -v "$(cd "$OUT" && pwd)":/out "postgres:$server_major" \
    pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="/out/$(basename "$FILE")" "$URL"
else
  echo "pg_dump $local_major is older than the server ($server_major) and docker is unavailable" >&2; exit 3
fi
chmod 600 "$FILE"
# sanity check: the archive's table of contents must list the core tables
# Capture the full listing before grepping; `| grep -q` can EPIPE pg_restore under pipefail (FX-052).
TOC="$(pg_restore --list "$FILE")" || { echo "pg_restore could not list: $FILE" >&2; exit 4; }
grep -qE 'TABLE public (users|dms)' <<<"$TOC" || { echo "backup looks empty/corrupt: $FILE" >&2; exit 4; }
echo "backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
ls -1t "$OUT"/openlounge-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
