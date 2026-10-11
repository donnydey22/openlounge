#!/usr/bin/env bash
# REVIEW-ONLY. This opens ONLY direct UDP media after MEDIASOUP_FIREWALL_APPROVED=YES.
# TCP is deliberately not opened: a Mediasoup TCP candidate would bypass the required LiveKit-over-TCP fallback.
set -euo pipefail
[[ ${MEDIASOUP_FIREWALL_APPROVED:-} == YES ]] || { echo "Refusing: set MEDIASOUP_FIREWALL_APPROVED=YES only after review." >&2; exit 64; }
[[ $EUID -eq 0 ]] || { echo "Run with sudo after review." >&2; exit 64; }
min=${MEDIASOUP_RTC_MIN_PORT:-40000}
max=${MEDIASOUP_RTC_MAX_PORT:-49999}
source "$(dirname "${BASH_SOURCE[0]}")/validate-pilot-range.sh"
mediasoup_validate_pilot_range "$min" "$max"
ufw allow "$min:$max/udp" comment 'Open Lounge Mediasoup direct UDP pilot'
ufw status numbered
