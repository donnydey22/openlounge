#!/usr/bin/env bash
# This script is intentionally inert unless the reviewer sets MEDIASOUP_INSTALL_APPROVED=YES at execution time.
# Run from the repository root only after a written review of the plan, firewall rule, secrets, and coturn backup.
set -euo pipefail
[[ ${MEDIASOUP_INSTALL_APPROVED:-} == YES ]] || { echo "Refusing: set MEDIASOUP_INSTALL_APPROVED=YES only after review." >&2; exit 64; }
[[ $EUID -eq 0 ]] || { echo "Run with sudo after review." >&2; exit 64; }
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
"$root/media-sfu/deploy/preflight.sh"
"$root/media-sfu/deploy/backup-coturn-config.sh"

env_file=/etc/openlounge-mediasoup-sfu.env
[[ -f "$env_file" && ! -L "$env_file" ]] || { echo "Missing regular root-owned $env_file" >&2; exit 2; }
[[ $(stat -c '%U:%G' "$env_file") == root:root && $(stat -c '%a' "$env_file") == 600 ]] || {
  echo "$env_file must be root:root with mode 0600; refusing to load media secrets." >&2
  exit 2
}

id -u openlounge-sfu >/dev/null 2>&1 || useradd --system --home /var/lib/openlounge-mediasoup-sfu --shell /usr/sbin/nologin openlounge-sfu
install -d -o openlounge-sfu -g openlounge-sfu -m 0750 /opt/openlounge-mediasoup-sfu /var/lib/openlounge-mediasoup-sfu
rsync -a --delete --exclude node_modules "$root/media-sfu/" /opt/openlounge-mediasoup-sfu/media-sfu/
cd /opt/openlounge-mediasoup-sfu/media-sfu
sudo -u openlounge-sfu npm ci --omit=dev --no-audit --no-fund
install -m 0644 "$root/media-sfu/deploy/openlounge-sfu.slice" /etc/systemd/system/openlounge-sfu.slice
install -m 0644 "$root/media-sfu/deploy/openlounge-mediasoup-sfu.service" /etc/systemd/system/openlounge-mediasoup-sfu.service
install -d -m 0755 /etc/systemd/system/coturn.service.d
install -m 0644 "$root/media-sfu/deploy/coturn-reserve.conf" /etc/systemd/system/coturn.service.d/20-openlounge-reserve.conf
systemctl daemon-reload
systemctl enable --now openlounge-mediasoup-sfu.service
systemctl --no-pager status coturn.service openlounge-mediasoup-sfu.service
