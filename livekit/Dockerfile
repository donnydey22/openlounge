# LiveKit SFU, wrapped for Railway.
#
# Upstream's image is a bare `alpine + /livekit-server` with no shell tooling and
# no entrypoint hook, and Railway needs three things it cannot express as
# variables: a config file generated at boot, an ICE/TCP listener bound to the
# public proxy port, and a bridge from the container port onto it. One thin
# layer on the published image gets all three and keeps `latest` floating.
#
# Adapted from gridalpha/livekit-railway (Apache-2.0). Build context: livekit/
FROM livekit/livekit-server:latest

# socat  - bridges the Railway TCP proxy's container port onto the ICE/TCP port
# tini   - reaps the bridge and forwards SIGTERM so a redeploy drains the node
# bind-tools - resolves the proxy hostname to the address advertised in candidates
RUN apk add --no-cache socat tini bind-tools ca-certificates

COPY entrypoint.sh /railway-entrypoint.sh
RUN chmod +x /railway-entrypoint.sh

# Railway's runtime holds PID 1, so tini must register as a subreaper and pass
# signals to the whole group or socat outlives the deploy.
ENV TINI_SUBREAPER=1 \
    TINI_KILL_PROCESS_GROUP=1

EXPOSE 7880
ENTRYPOINT ["/railway-entrypoint.sh"]
