#!/usr/bin/env bash
# Read-only preflight. It must pass before any reviewed installation; it performs no firewall, package, user, or service change.
set -euo pipefail
min=${MEDIASOUP_RTC_MIN_PORT:-40000}
max=${MEDIASOUP_RTC_MAX_PORT:-49999}
[[ $min =~ ^[0-9]+$ && $max =~ ^[0-9]+$ && $min -le $max && $max -lt 50000 ]] || { echo "Invalid non-overlapping SFU range: $min-$max" >&2; exit 2; }
[[ -r /sys/fs/cgroup/cgroup.controllers ]] || { echo "cgroup v2 is required for hard memory/CPU controls" >&2; exit 2; }
controllers=$(cat /sys/fs/cgroup/cgroup.controllers)
[[ " $controllers " == *" cpu "* && " $controllers " == *" memory "* ]] || { echo "cpu and memory cgroup controllers are required" >&2; exit 2; }

echo "--- current listeners (must show coturn only before install) ---"
ss -lntup || true
echo "--- coturn status ---"
systemctl is-active coturn
echo "--- configured firewall ---"
ufw status numbered || true
echo "--- resources ---"
free -h
nproc
printf 'range=%s-%s udp-only; health=127.0.0.1:8081; SFU hard cap=35%% CPU / 448M; coturn reservation=768M floor\n' "$min" "$max"
