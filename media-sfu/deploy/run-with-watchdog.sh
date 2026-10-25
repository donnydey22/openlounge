#!/usr/bin/env bash
# Keep the existing single systemd unit healthy without adding a supervisor daemon.
# systemd restarts this control-group if the loop cannot obtain a healthy local response.
set -euo pipefail

node_bin=${OPENLOUNGE_NODE_BIN:-/opt/openlounge-node/bin/node}
health_port=${MEDIASOUP_HEALTH_PORT:-8081}
startup_timeout=${MEDIASOUP_WATCHDOG_START_TIMEOUT_SEC:-60}
notify_bin=${SYSTEMD_NOTIFY_BIN:-/usr/bin/systemd-notify}
[[ -x "$node_bin" ]] || { echo "Pinned Node runtime is unavailable: $node_bin" >&2; exit 2; }
[[ -x "$notify_bin" ]] || { echo "systemd-notify is unavailable: $notify_bin" >&2; exit 2; }
[[ $startup_timeout =~ ^[1-9][0-9]*$ ]] || { echo "Invalid watchdog start timeout" >&2; exit 2; }
[[ $health_port =~ ^[1-9][0-9]*$ && $health_port -le 65535 ]] || { echo "Invalid loopback health port" >&2; exit 2; }
health_url="http://127.0.0.1:${health_port}/healthz"

watchdog_usec=${WATCHDOG_USEC:-30000000}
[[ $watchdog_usec =~ ^[1-9][0-9]*$ ]] || watchdog_usec=30000000
interval=$((watchdog_usec / 3000000))
(( interval < 1 )) && interval=1

notify() {
  [[ -n ${NOTIFY_SOCKET:-} ]] || return 0
  "$notify_bin" --no-block "$@" >/dev/null 2>&1 || true
}

# Liveness depends only on the local SFU process/worker. The website gateway link
# drops briefly during every Railway deploy; that is logged, never fatal.
gateway_down_since=0
gateway_warn_after=${MEDIASOUP_GATEWAY_WARN_SEC:-600}
gateway_warned=0
check_gateway() {
  local body=$1
  if [[ $body == *'"gateway":true'* ]]; then
    if (( gateway_down_since )); then
      echo "SFU gateway link restored after ~$((SECONDS + 1 - gateway_down_since))s" >&2
    fi
    gateway_down_since=0; gateway_warned=0
  else
    if (( !gateway_down_since )); then
      gateway_down_since=$((SECONDS + 1))
      echo "SFU gateway link down (not fatal; worker liveness only)" >&2
    elif (( !gateway_warned && SECONDS + 1 - gateway_down_since >= gateway_warn_after )); then
      echo "WARNING: SFU gateway link down for over ${gateway_warn_after}s (not restarting; worker alive)" >&2
      gateway_warned=1
    fi
  fi
}

healthy() {
  local body
  body=$(curl --fail --silent --show-error --max-time 2 "$health_url") || return 1
  check_gateway "$body"
  [[ $body == *'"ok":true'* && $body == *'"worker":true'* ]]
}

"$node_bin" src/index.mjs &
child=$!
stop() {
  kill -TERM "$child" 2>/dev/null || true
  wait "$child" 2>/dev/null || true
  notify --stopping --status="stopping"
  exit 0
}
trap stop INT TERM

deadline=$((SECONDS + startup_timeout))
ready=0
while kill -0 "$child" 2>/dev/null; do
  if healthy; then
    if (( !ready )); then
      notify --ready --status="healthy"
      ready=1
    fi
    notify --status="healthy" WATCHDOG=1
  elif (( !ready && SECONDS >= deadline )); then
    echo "SFU did not become healthy before watchdog start timeout" >&2
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
    exit 1
  fi
  sleep "$interval"
done
wait "$child"
