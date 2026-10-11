#!/usr/bin/env bash
# Refuse an SFU start unless the reviewed local rule and root-owned DigitalOcean verification attestation are present.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 64; }
attestation=/etc/openlounge-mediasoup-firewall-verified
[[ -f "$attestation" && ! -L "$attestation" ]] || { echo "Missing reviewed cloud-firewall attestation: $attestation" >&2; exit 2; }
[[ $(stat -c '%U:%G' "$attestation") == root:root && $(stat -c '%a' "$attestation") == 600 ]] || {
  echo "$attestation must be root:root with mode 0600" >&2
  exit 2
}
for line in \
  'droplet_id=608073501' \
  'cloud_firewall_id=fde5a7b3-020b-4d9b-bcc6-40bac18e213f' \
  'inbound_rule=allow udp 40000-49999 0.0.0.0/0 ::/0'; do
  grep -Fx "$line" "$attestation" >/dev/null || { echo "Cloud-firewall attestation is missing: $line" >&2; exit 2; }
done
status=$(ufw status)
printf '%s\n' "$status" | grep -E '^40000:49999/udp[[:space:]]+ALLOW IN[[:space:]]+Anywhere$' >/dev/null || {
  echo "Missing reviewed IPv4 UFW allow rule for 40000:49999/udp" >&2
  exit 2
}
printf '%s\n' "$status" | grep -E '^40000:49999/udp[[:space:]]+ALLOW IN[[:space:]]+Anywhere \(v6\)$' >/dev/null || {
  echo "Missing reviewed IPv6 UFW allow rule for 40000:49999/udp" >&2
  exit 2
}
