#!/usr/bin/env bash
# Runs scripts/test-time.ts in fixed zones (incl. DST boundaries and +13:45).
set -u
cd "$(dirname "$0")/.."
rc=0
for tz in America/Phoenix Asia/Kolkata Europe/London Pacific/Chatham UTC; do
  out=$(TZ=$tz LC_ALL=en_US.UTF-8 npx tsx scripts/test-time.ts) || rc=1
  echo "$out" | grep -E "✗|PASSED|FAILED"
done
out=$(TZ=America/Phoenix LC_ALL=en_GB.UTF-8 H24=1 npx tsx scripts/test-time.ts) || rc=1
echo "$out" | grep -E "✗|PASSED|FAILED" | sed 's/]$/, en-GB 24h]/'
exit $rc
