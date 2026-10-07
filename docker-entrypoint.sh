#!/bin/sh
# Open Lounge container entrypoint.
# Railway (and most hosts) mount volumes owned by root, which the unprivileged `node` user can't write.
# Start as root, make sure DATA_DIR (avatar uploads; db.json only without DATABASE_URL) belongs to `node`,
# then drop privileges and exec the server. If we're not root (e.g. RAILWAY_RUN_UID set), just exec.
set -e
DATA_DIR="${DATA_DIR:-/data}"
APP_USER="${APP_USER:-node}"
# Size the V8 heap to the container (75% of the cgroup memory limit, 256–2048 MB) unless NODE_OPTIONS already sets it,
# so Node GCs before the container is OOM-killed instead of growing to its default ceiling.
case "${NODE_OPTIONS:-}" in *max-old-space-size*) ;; *)
  lim=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo max)
  if [ "$lim" != "max" ] && [ "$lim" -lt 68719476736 ] 2>/dev/null; then
    mb=$((lim / 1048576 * 3 / 4)); [ "$mb" -lt 256 ] && mb=256; [ "$mb" -gt 2048 ] && mb=2048
    export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=$mb"
  fi ;;
esac
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
