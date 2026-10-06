#!/bin/sh
# Open Lounge container entrypoint.
# Railway (and most hosts) mount volumes owned by root, which the unprivileged `node` user can't write.
# Start as root, make sure DATA_DIR (avatar uploads; db.json only without DATABASE_URL) belongs to `node`,
# then drop privileges and exec the server. If we're not root (e.g. RAILWAY_RUN_UID set), just exec.
set -e
DATA_DIR="${DATA_DIR:-/data}"
APP_USER="${APP_USER:-node}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR/avatars"
  chown "$APP_USER:$APP_USER" "$DATA_DIR" "$DATA_DIR/avatars" 2>/dev/null || true
  chown -R "$APP_USER:$APP_USER" "$DATA_DIR/avatars" 2>/dev/null || true
  drop="setpriv --reuid=$APP_USER --regid=$APP_USER --init-groups"
  if command -v setpriv >/dev/null 2>&1 && $drop test -w "$DATA_DIR" 2>/dev/null; then
    export HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
    exec $drop "$@"
  fi
  echo "[entrypoint] $DATA_DIR is not writable by $APP_USER — running as root" >&2
fi
exec "$@"
