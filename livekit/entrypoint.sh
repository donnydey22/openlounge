#!/bin/sh
# LiveKit SFU entrypoint for Railway.
#
# Railway does not route inbound UDP, so WebRTC media has to ride ICE/TCP.
# LiveKit advertises the exact port it binds, while a Railway TCP proxy maps a
# random *public* port onto a fixed *container* port -- so the two disagree by
# construction. This entrypoint binds LiveKit's ICE/TCP listener on the *public*
# port number and bridges the container port onto it, then advertises the
# proxy's own address. Every value is re-read at boot, so a regenerated proxy
# port heals itself on the next deploy.
#
# The bridge must dial the container's own interface address, never 127.0.0.1:
# pion's TCP mux indexes candidate connections by (ufrag, family, *local IP*),
# and the ICE agent registers itself under the interface address it gathered a
# host candidate on. A loopback-dialled connection arrives with LocalAddr
# 127.0.0.1, misses that lookup, and is parked on a fresh connection no agent
# ever reads -- so the mux logs "Added connection", the agent logs "Failed to
# ping without candidate pairs", and ICE hangs in `checking` until it times out.
set -eu

log() { printf 'railway-entrypoint: %s\n' "$*" >&2; }
# escape a value for a double-quoted YAML scalar
yesc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

: "${PORT:=7880}"
CONFIG_DIR=/etc/livekit
CONFIG="$CONFIG_DIR/config.yaml"
mkdir -p "$CONFIG_DIR"

# ------------------------------------------------------------------ API keys
if [ -z "${LIVEKIT_API_KEY:-}" ] || [ -z "${LIVEKIT_API_SECRET:-}" ]; then
  log "FATAL: LIVEKIT_API_KEY and LIVEKIT_API_SECRET must both be set."
  exit 1
fi
if [ "${#LIVEKIT_API_SECRET}" -lt 32 ]; then
  log "WARNING: LIVEKIT_API_SECRET is under 32 characters; LiveKit recommends 32+."
fi

# -------------------------------------------------------------- ICE over TCP
ICE_TCP_PORT=""
NODE_IP=""
BRIDGE_FROM=""
if [ -n "${RAILWAY_TCP_PROXY_DOMAIN:-}" ] && [ -n "${RAILWAY_TCP_PROXY_PORT:-}" ]; then
  ICE_TCP_PORT="$RAILWAY_TCP_PROXY_PORT"
  NODE_IP="${LIVEKIT_NODE_IP:-}"
  if [ -z "$NODE_IP" ]; then
    NODE_IP=$(dig +short +timeout=3 A "$RAILWAY_TCP_PROXY_DOMAIN" 2>/dev/null \
      | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1)
  fi
  if [ -z "$NODE_IP" ]; then
    NODE_IP=$(getent ahostsv4 "$RAILWAY_TCP_PROXY_DOMAIN" 2>/dev/null | awk 'NR==1 {print $1}')
  fi
  if [ -z "$NODE_IP" ]; then
    log "FATAL: could not resolve $RAILWAY_TCP_PROXY_DOMAIN to an IPv4 address."
    log "FATAL: set LIVEKIT_NODE_IP to the proxy's address to override."
    exit 1
  fi
  BRIDGE_FROM="${RAILWAY_TCP_APPLICATION_PORT:-7881}"
  log "ICE/TCP advertised as ${NODE_IP}:${ICE_TCP_PORT} (${RAILWAY_TCP_PROXY_DOMAIN})"
else
  log "WARNING: this service has no Railway TCP proxy, so WebRTC media cannot"
  log "WARNING: connect -- signalling will work and every room will stay silent."
  log "WARNING: create one over container port 7881, then redeploy:"
  log "WARNING:   railway tcp-proxy create --port 7881 --service <this service>"
fi

if [ -n "$ICE_TCP_PORT" ]; then
  RTC_BLOCK=$(printf '%s\n' \
    "  tcp_port: ${ICE_TCP_PORT}" \
    "  force_tcp: true" \
    "  use_external_ip: false" \
    "  node_ip: \"$(yesc "$NODE_IP")\"")
else
  # No proxy: keep the stock shape so the node still boots and stays diagnosable.
  RTC_BLOCK=$(printf '%s\n' \
    "  tcp_port: 7881" \
    "  use_external_ip: true")
fi

# --------------------------------------------------------------------- Redis
# Optional. With Redis, LiveKit runs distributed and rooms survive across
# replicas; without it a single node keeps room state in memory.
REDIS_BLOCK=""
if [ -n "${LIVEKIT_REDIS_HOST:-}" ]; then
  _addr="$LIVEKIT_REDIS_HOST"
  case "$_addr" in
    *:*) : ;;
    *)   _addr="${_addr}:${LIVEKIT_REDIS_PORT:-6379}" ;;
  esac
  REDIS_BLOCK="redis:
  address: \"$(yesc "$_addr")\""
  [ -n "${LIVEKIT_REDIS_USERNAME:-}" ] && REDIS_BLOCK="$REDIS_BLOCK
  username: \"$(yesc "$LIVEKIT_REDIS_USERNAME")\""
  [ -n "${LIVEKIT_REDIS_PASSWORD:-}" ] && REDIS_BLOCK="$REDIS_BLOCK
  password: \"$(yesc "$LIVEKIT_REDIS_PASSWORD")\""
  log "redis: distributed mode via ${_addr}"
else
  log "redis: not configured, running as a single in-memory node"
fi

# ------------------------------------------------------------------ webhooks
WEBHOOK_BLOCK=""
if [ -n "${LIVEKIT_WEBHOOK_URLS:-}" ]; then
  WEBHOOK_BLOCK="webhook:
  api_key: \"$(yesc "$LIVEKIT_API_KEY")\"
  urls:"
  _old_ifs="$IFS"; IFS=','
  for _u in $LIVEKIT_WEBHOOK_URLS; do
    _u=$(printf '%s' "$_u" | tr -d '[:space:]')
    [ -n "$_u" ] || continue
    WEBHOOK_BLOCK="$WEBHOOK_BLOCK
    - \"$(yesc "$_u")\""
  done
  IFS="$_old_ifs"
fi

# ----------------------------------------------------------------- the config
{
  echo "port: ${PORT}"
  echo "logging:"
  echo "  level: ${LIVEKIT_LOG_LEVEL:-info}"
  echo "  json: false"
  echo "keys:"
  echo "  \"$(yesc "$LIVEKIT_API_KEY")\": \"$(yesc "$LIVEKIT_API_SECRET")\""
  echo "rtc:"
  echo "$RTC_BLOCK"
  echo "room:"
  echo "  auto_create: ${LIVEKIT_ROOM_AUTO_CREATE:-true}"
  echo "  empty_timeout: ${LIVEKIT_ROOM_EMPTY_TIMEOUT:-300}"
  echo "  departure_timeout: ${LIVEKIT_ROOM_DEPARTURE_TIMEOUT:-20}"
  echo "turn:"
  echo "  enabled: false"
  [ -n "$REDIS_BLOCK" ] && echo "$REDIS_BLOCK"
  [ -n "$WEBHOOK_BLOCK" ] && echo "$WEBHOOK_BLOCK"
} > "$CONFIG"
chmod 600 "$CONFIG"

# The generated config carries the API secret, so print a redacted copy only.
log "generated $CONFIG:"
sed -e "s/$(printf '%s' "$LIVEKIT_API_SECRET" | sed 's/[]\/$*.^[]/\\&/g')/<redacted>/g" \
    -e "s/^  password:.*/  password: \"<redacted>\"/" "$CONFIG" >&2

# The bridge has to outlive the shell, and LiveKit has to be PID-1's child so
# SIGTERM drains the node rather than killing it.
if [ -n "$BRIDGE_FROM" ] && [ "$BRIDGE_FROM" != "$ICE_TCP_PORT" ]; then
  BRIDGE_TO="${LIVEKIT_BRIDGE_TARGET_IP:-}"
  if [ -z "$BRIDGE_TO" ]; then
    BRIDGE_TO=$(ip -4 -o addr show scope global 2>/dev/null \
      | awk '{print $4}' | cut -d/ -f1 | head -n 1)
  fi
  if [ -z "$BRIDGE_TO" ]; then
    BRIDGE_TO=$(hostname -i 2>/dev/null | tr ' ' '\n' \
      | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' | head -n 1)
  fi
  if [ -z "$BRIDGE_TO" ]; then
    log "FATAL: no non-loopback IPv4 address on this container to bridge to."
    log "FATAL: set LIVEKIT_BRIDGE_TARGET_IP to override."
    exit 1
  fi
  log "bridging container :${BRIDGE_FROM} -> ${BRIDGE_TO}:${ICE_TCP_PORT} (ICE/TCP)"
  socat TCP-LISTEN:"$BRIDGE_FROM",fork,reuseaddr \
        TCP:"$BRIDGE_TO":"$ICE_TCP_PORT",retry=5,interval=1 &
fi

exec tini -s -- /livekit-server --config "$CONFIG"
