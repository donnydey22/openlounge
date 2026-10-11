#!/usr/bin/env bash
# Read-only backup helper. It changes no coturn setting and never prints secret-bearing configuration to stdout.
set -euo pipefail
umask 077
out_root=${1:-/var/backups/openlounge-coturn}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$out_root/$stamp"
install -d -m 0700 "$out"

paths=()
for p in /etc/turnserver.conf /etc/turnserver /etc/coturn /etc/default/coturn; do
  [[ -e "$p" ]] && paths+=("$p")
done
if ((${#paths[@]} == 0)); then
  echo "No known coturn configuration path found; aborting without changes." >&2
  exit 1
fi

tar --numeric-owner --xattrs --acls -cpf "$out/coturn-config.tar" "${paths[@]}"
systemctl cat coturn >"$out/coturn-systemd-unit.txt"
systemctl show coturn --no-pager >"$out/coturn-systemd-show.txt"
sha256sum "$out/coturn-config.tar" "$out/coturn-systemd-unit.txt" "$out/coturn-systemd-show.txt" >"$out/SHA256SUMS"
printf '%s\n' "$out"
