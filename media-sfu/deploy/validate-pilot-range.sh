#!/usr/bin/env bash
# Source-only helper shared by preflight and firewall scripts. The first pilot is intentionally one fixed range.
mediasoup_validate_pilot_range() {
  local min=${1:-${MEDIASOUP_RTC_MIN_PORT:-40000}}
  local max=${2:-${MEDIASOUP_RTC_MAX_PORT:-49999}}
  if [[ ! $min =~ ^[0-9]+$ || ! $max =~ ^[0-9]+$ || $min -ne 40000 || $max -ne 49999 ]]; then
    echo "Pilot SFU range must be exactly 40000-49999/udp; refusing $min-$max" >&2
    return 2
  fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  mediasoup_validate_pilot_range "$@"
fi
