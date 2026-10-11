#!/usr/bin/env bash
# Install the single pinned Node LTS runtime needed by the locked Mediasoup dependency tree.
# This uses the official nodejs.org release archive and validates its committed SHA-256 before activation.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 64; }
case "$(uname -m)" in
  x86_64) node_arch=x64 ;;
  *) echo "Only the reviewed x86_64 media host is supported by this pinned installer." >&2; exit 2 ;;
esac

node_version=v22.23.3
archive="node-${node_version}-linux-${node_arch}.tar.xz"
expected_sha256=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
release_url="https://nodejs.org/dist/${node_version}/${archive}"
target="/opt/openlounge-node-${node_version}"
link=/opt/openlounge-node

if [[ -x "$target/bin/node" && "$($target/bin/node --version)" == "$node_version" ]]; then
  ln -sfn "$target" "$link"
  exit 0
fi

tmp=$(mktemp -d /tmp/openlounge-node.XXXXXX)
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error "$release_url" -o "$tmp/$archive"
printf '%s  %s\n' "$expected_sha256" "$tmp/$archive" | sha256sum -c -
tar -C "$tmp" -xJf "$tmp/$archive"
install -d -m 0755 /opt
rm -rf "$target"
mv "$tmp/node-${node_version}-linux-${node_arch}" "$target"
ln -sfn "$target" "$link"
"$link/bin/node" --version | grep -Fx "$node_version" >/dev/null
"$link/bin/npm" --version >/dev/null
