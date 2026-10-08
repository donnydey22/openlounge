#!/bin/sh
# Open Lounge media cache entrypoint (same shape as the app's docker-entrypoint.sh: root only long enough to
# prepare the volume at $DATA_DIR, then nginx drops its workers to the unprivileged `nginx` user).
# Renders /etc/nginx/nginx.conf from the template. Secrets stay in the environment (read by njs), never on disk.
set -eu
log() { printf 'media-cache: %s\n' "$*" >&2; }

: "${PORT:=8080}"
: "${DATA_DIR:=/data}"
: "${MEDIA_CACHE_INTERNAL_PORT:=8081}"
: "${MEDIA_ORIGIN_URL:=http://openlounge.railway.internal:8081}"
: "${MEDIA_CACHE_MAX_SIZE:=400m}"
: "${MEDIA_CACHE_MIN_FREE:=48m}"
: "${MEDIA_CACHE_INACTIVE:=30d}"
APP_USER="${APP_USER:-nginx}"
CONF_DIR="${NGINX_CONF_DIR:-/etc/nginx}"
MODULES_DIR="${NGINX_MODULES_DIR:-/etc/nginx/modules}"
TMP_DIR="${NGINX_TMP_DIR:-/tmp/nginx}"

# ---- origin: http://host:port (IPv6 literal allowed as [addr]:port)
hostport=$(printf '%s' "$MEDIA_ORIGIN_URL" | sed -E 's#^https?://##; s#/.*$##')
case "$hostport" in
  \[*) host=$(printf '%s' "$hostport" | sed -E 's#^(\[[^]]+\]).*#\1#') ;;
  *)   host=$(printf '%s' "$hostport" | sed -E 's#:[0-9]+$##') ;;
esac
case "$hostport" in *]:*|[!\[]*:*) ;; *) hostport="$hostport:80" ;; esac
# `resolve` (re-resolve on DNS TTL; nginx >= 1.27.3) only for names, not IP literals
if printf '%s' "$host" | grep -Eq '^\[|^[0-9.]+$'; then resolve=""; else resolve="resolve"; fi

# ---- resolver: the container's own (Railway private DNS, IPv6 on older environments)
resolvers=""
for ns in $(awk '/^nameserver/ {print $2}' /etc/resolv.conf 2>/dev/null); do
  case "$ns" in *:*) resolvers="$resolvers [$(printf '%s' "$ns" | sed 's/%.*//')]" ;; *) resolvers="$resolvers $ns" ;; esac
done
[ -n "$resolvers" ] || resolvers="127.0.0.11"
log "origin=$hostport resolve=${resolve:-no} resolver=$resolvers port=$PORT internal=$MEDIA_CACHE_INTERNAL_PORT cache=$DATA_DIR/cache max=$MEDIA_CACHE_MAX_SIZE"

sig="${MEDIA_SIGNING_SECRET:-}"; [ "${#sig}" -ge 16 ] || log "WARNING: MEDIA_SIGNING_SECRET is not set (every /media request will get 403; /readyz fails)"
[ -n "${MEDIA_CACHE_PURGE_SECRET:-}" ] || log "WARNING: MEDIA_CACHE_PURGE_SECRET is not set (purge endpoint disabled)"

sed -e "s#__PORT__#$PORT#g" -e "s#__INTERNAL_PORT__#$MEDIA_CACHE_INTERNAL_PORT#g" \
    -e "s#__ORIGIN_HOSTPORT__#$hostport#g" -e "s#__ORIGIN_HOST__#$host#g" -e "s#__ORIGIN_RESOLVE__#$resolve#g" \
    -e "s#__RESOLVER__#$resolvers#g" -e "s#__DATA_DIR__#$DATA_DIR#g" -e "s#__CONF_DIR__#$CONF_DIR#g" -e "s#__MODULES_DIR__#$MODULES_DIR#g" -e "s#__TMP_DIR__#$TMP_DIR#g" \
    -e "s#__MAX_SIZE__#$MEDIA_CACHE_MAX_SIZE#g" -e "s#__MIN_FREE__#$MEDIA_CACHE_MIN_FREE#g" -e "s#__INACTIVE__#$MEDIA_CACHE_INACTIVE#g" \
    "$CONF_DIR/nginx.conf.template" > "$CONF_DIR/nginx.conf"

mkdir -p "$TMP_DIR"
if [ "$(id -u)" = "0" ]; then
  chown "$APP_USER:$APP_USER" "$TMP_DIR" 2>/dev/null || true
  mkdir -p "$DATA_DIR/cache" "$DATA_DIR/cache-meta/tomb"
  chown -R "$APP_USER:$APP_USER" "$DATA_DIR/cache" "$DATA_DIR/cache-meta" 2>/dev/null || true
fi
nginx -e stderr -t -q -p "$CONF_DIR" -c "$CONF_DIR/nginx.conf"
exec nginx -e stderr -p "$CONF_DIR" -c "$CONF_DIR/nginx.conf" -g 'daemon off;'
