#!/bin/sh
# Start the cache locally (same entrypoint + template as the image) against the mock origin.
# Usage: test/run-local.sh  → cache on :18080 (public), :18083 (internal), origin mock on :18081 (+ctl :18082)
set -eu
export PATH="$PATH:/usr/sbin"
HERE=$(cd "$(dirname "$0")/.." && pwd)
W=${MEDIA_CACHE_TEST_DIR:-/tmp/media-cache-test}
pkill -f "nginx: master process.* -p $W/conf" 2>/dev/null || true
pkill -f "media-cache/test/mock-origin.mjs" 2>/dev/null || true
sleep 0.3
rm -rf "$W"; mkdir -p "$W/conf/njs" "$W/data"
cp "$HERE/nginx.conf.template" "$HERE/media-guard.conf" "$W/conf/"; cp "$HERE"/njs/*.js "$W/conf/njs/"; cp /etc/nginx/mime.types "$W/conf/"
: "${MEDIA_SIGNING_SECRET:?set MEDIA_SIGNING_SECRET}"; : "${MEDIA_CACHE_PURGE_SECRET:?set MEDIA_CACHE_PURGE_SECRET}"
export MEDIA_SIGNING_SECRET MEDIA_CACHE_PURGE_SECRET
node "$HERE/test/mock-origin.mjs" > "$W/origin.log" 2>&1 < /dev/null &
PORT=18080 MEDIA_CACHE_INTERNAL_PORT=18083 DATA_DIR="$W/data" MEDIA_ORIGIN_URL="${MEDIA_ORIGIN_URL:-http://localhost:18081}" \
NGINX_CONF_DIR="$W/conf" NGINX_MODULES_DIR=/usr/lib/nginx/modules NGINX_TMP_DIR="$W/tmp" MEDIA_CACHE_MAX_SIZE=200m \
  setsid sh "$HERE/entrypoint.sh" > "$W/nginx.log" 2>&1 < /dev/null &
for i in $(seq 1 50); do curl -fs -o /dev/null http://127.0.0.1:18080/healthz && curl -fs -o /dev/null http://127.0.0.1:18081/media/healthz && break; sleep 0.2; done
curl -fsS http://127.0.0.1:18080/readyz; echo
