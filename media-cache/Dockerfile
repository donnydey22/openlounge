# Open Lounge media cache: self-hosted, single-region cache in front of the media origin (the `openlounge` service).
# Build context: media-cache/ (deployed with `railway up media-cache --path-as-root --service media-cache`).
# nginx (official image, ships the njs module) + proxy_cache on a Railway volume at $DATA_DIR.
# Contract with the origin: /workspace/media/CACHE_CONTRACT.md (v1) — mirrored in media-cache/README.md.
FROM nginx:1.31-alpine

# tini: reaps nginx workers and forwards SIGTERM (graceful drain on redeploy), same as the livekit wrapper
RUN apk add --no-cache tini \
 && rm -f /etc/nginx/conf.d/default.conf

COPY nginx.conf.template media-guard.conf /etc/nginx/
COPY njs/ /etc/nginx/njs/
COPY entrypoint.sh /usr/local/bin/media-cache-entrypoint.sh
RUN chmod 755 /usr/local/bin/media-cache-entrypoint.sh && mkdir -p /data

ENV PORT=8080 \
    DATA_DIR=/data \
    MEDIA_CACHE_INTERNAL_PORT=8081 \
    MEDIA_ORIGIN_URL=http://openlounge.railway.internal:8081 \
    MEDIA_CACHE_MAX_SIZE=400m \
    TINI_SUBREAPER=1
EXPOSE 8080 8081
STOPSIGNAL SIGQUIT
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/media-cache-entrypoint.sh"]
