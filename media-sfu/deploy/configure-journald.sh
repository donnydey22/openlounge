#!/usr/bin/env bash
# Configure bounded persistent journald storage on the dedicated coturn/SFU media host.
set -euo pipefail

[[ ${MEDIASOUP_JOURNAL_APPROVED:-} == YES ]] || { echo "Refusing: set MEDIASOUP_JOURNAL_APPROVED=YES after log retention review." >&2; exit 64; }
[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 64; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
install -d -m 0755 /etc/systemd/journald.conf.d
install -d -o root -g systemd-journal -m 2755 /var/log/journal
install -m 0644 "$root/media-sfu/deploy/openlounge-media-journal.conf" /etc/systemd/journald.conf.d/60-openlounge-media.conf
# journald reloads its configuration on HUP. Flush moves volatile records to the persistent directory without
# restarting coturn, the SFU, or another application service.
systemctl kill --kill-who=main --signal=HUP systemd-journald.service
journalctl --flush
