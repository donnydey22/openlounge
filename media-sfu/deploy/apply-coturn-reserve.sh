#!/usr/bin/env bash
# Apply the already-reviewed coturn resource floor without restarting coturn, then prove it is live before SFU start.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 64; }
systemctl is-active --quiet coturn.service || { echo "coturn must be active before applying its live reservation." >&2; exit 2; }
systemctl set-property --runtime coturn.service \
  CPUWeight=1000 MemoryMin=768M MemoryLow=768M MemoryHigh=1024M MemoryMax=1280M TasksMax=256

control_group=$(systemctl show coturn.service --property=ControlGroup --value)
[[ $control_group == /* && -d "/sys/fs/cgroup$control_group" ]] || { echo "Unable to locate coturn cgroup." >&2; exit 2; }
cgroup="/sys/fs/cgroup$control_group"

expect_property() {
  local property=$1 expected=$2 actual
  actual=$(systemctl show coturn.service --property="$property" --value)
  [[ $actual == "$expected" ]] || { echo "coturn $property is $actual, expected $expected" >&2; exit 2; }
}
expect_cgroup() {
  local file=$1 expected=$2 actual
  actual=$(<"$cgroup/$file")
  [[ $actual == "$expected" ]] || { echo "coturn cgroup $file is $actual, expected $expected" >&2; exit 2; }
}

expect_property CPUWeight 1000
expect_property MemoryMin 805306368
expect_property MemoryLow 805306368
expect_property MemoryHigh 1073741824
expect_property MemoryMax 1342177280
expect_property TasksMax 256
expect_cgroup cpu.weight 1000
expect_cgroup memory.min 805306368
expect_cgroup memory.low 805306368
expect_cgroup memory.high 1073741824
expect_cgroup memory.max 1342177280
expect_cgroup pids.max 256
