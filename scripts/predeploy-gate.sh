#!/usr/bin/env bash
# Pre-deploy regression gate (Open Lounge). Read-only against prod: no deploys, no restarts, no calls placed.
# Usage: scripts/predeploy-gate.sh [--skip-build] [--since-minutes N]
# Env: PG_TEST_BASE (default postgresql://ua@127.0.0.1:55433), RAILWAY_SERVICE, RAILWAY_ENV
set -uo pipefail
cd "$(dirname "$0")/.."
SVC=${RAILWAY_SERVICE:-85ca960c-3d16-4435-aca2-b19982673dd6}
ENVID=${RAILWAY_ENV:-6f0c8313-dbc9-46ba-af56-e7ad1cef830f}
PGB=${PG_TEST_BASE:-postgresql://ua@127.0.0.1:55433}
SKIP_BUILD=0; [[ "${1:-}" == "--skip-build" ]] && SKIP_BUILD=1
LOG=$(mktemp -d /tmp/olgate.XXXX); FAIL=0
pass(){ echo "PASS  $*"; }; fail(){ echo "FAIL  $*"; FAIL=1; }; warn(){ echo "WARN  $*"; }

echo "== 1. main vs prod"
git fetch -q origin
HEAD_SHA=$(git rev-parse HEAD); MAIN=$(git rev-parse origin/main); RT=$(git rev-parse origin/test/round-two)
PROD=$(railway deployment list -s "$SVC" -e "$ENVID" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s).find(d=>d.status==="SUCCESS");console.log(a?.meta?.commitHash||"")})')
[[ "$MAIN" == "$PROD" ]] && pass "origin/main == prod ($PROD)" || fail "origin/main $MAIN != prod $PROD"
[[ "$MAIN" == "$RT" ]] && pass "test/round-two == main" || warn "test/round-two $RT != main"
echo "   testing HEAD $HEAD_SHA"

echo "== 2. typecheck + suites"
npx tsc --noEmit >"$LOG/tsc" 2>&1 && pass tsc || fail "tsc (see $LOG/tsc)"
for d in groups_media_test groups_test invites_test media_test reactions_test typing_test ol_hardening_test; do
  psql "$PGB/postgres" -qc "create database $d" >/dev/null 2>&1 || true; done
if [[ $SKIP_BUILD == 0 ]]; then npx next build >"$LOG/build" 2>&1 && pass "next build" || fail "next build (see $LOG/build)"; fi
export TEST_DATABASE_URL="$PGB/ol_hardening_test"
for s in calls hardening presence typing reactions groups invites roomchat media; do
  npm run -s test:$s >"$LOG/$s" 2>&1; rc=$?
  sum=$(grep -E '^# (pass|fail) ' "$LOG/$s" | tr '\n' ' ')
  [[ $rc == 0 ]] && pass "test:$s $sum" || fail "test:$s $sum (see $LOG/$s)"
done
# Pinned call-path guards: Android 0.3.18 native gate / fallback / lifecycle, ring-ack, busy self-heal, ring retry
for pat in "native" "lifecycle" "ring → ack → accept" "busy: a live-map entry" "busy: a ringing call past" "ring retry"; do
  n=$(grep -E "^ *ok [0-9]+ - .*${pat}" "$LOG/calls" | wc -l); bad=$(grep -E "^ *not ok [0-9]+ - .*${pat}" "$LOG/calls" | wc -l)
  [[ $n -gt 0 && $bad == 0 ]] && pass "call guard '$pat' ($n ok)" || fail "call guard '$pat' ok=$n notok=$bad"
done

echo "== 3. Chatswop isolation"
if git diff --name-only "$PROD" HEAD | grep -qiE 'chatswop|camerax'; then fail "diff touches Chatswop/CameraX paths"; else pass "no Chatswop/CameraX code in diff vs prod (separate repo)"; fi

echo "== 4. prod read-only probes"
for p in healthz readyz; do c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://openlounge.app/$p); [[ $c == 200 ]] && pass "/$p 200" || fail "/$p $c"; done
node -e 'const W=require("ws");const w=new W("wss://openlounge.app/ws",{headers:{Origin:"https://openlounge.app"}});const t=setTimeout(()=>process.exit(1),8000);w.on("open",()=>{w.close();process.exit(0)});w.on("error",()=>process.exit(1));w.on("unexpected-response",()=>process.exit(1))' && pass "wss upgrade" || fail "wss upgrade"
timeout 8 openssl s_client -connect turn.openlounge.app:443 -servername turn.openlounge.app </dev/null 2>/dev/null | grep -q "Verify return code: 0" && pass "TURN TLS :443 cert ok" || fail "TURN TLS :443"
timeout 6 bash -c '</dev/tcp/165.232.137.71/40443' 2>/dev/null && pass "mediasoup TCP 40443 open" || fail "mediasoup TCP 40443"
c=$(curl -sI -o /dev/null -w '%{http_code}' --max-time 10 https://openlounge.app/downloads/openlounge-0.3.18-34.apk); [[ $c == 200 ]] && pass "APK 0.3.18-34 served" || fail "APK $c"

echo "== 5. prod [calls] log scan (current deployment)"
timeout 120 railway logs -s "$SVC" -e "$ENVID" -n 5000 >"$LOG/prod" 2>/dev/null
C=$(grep -c '\[calls\]' "$LOG/prod"); echo "   [calls] lines: $C"
for k in "native=true" "native-fallback-webview" "ring-retry\|repush" "busy" "livekit"; do echo "   $k: $(grep '\[calls\]' "$LOG/prod" | grep -c "$k")"; done
E=$(grep -E '\[calls\]|"calls' "$LOG/prod" | grep -ciE 'level="?error|uncaught|unhandled|exception')
[[ $E == 0 ]] && pass "no [calls] errors" || fail "$E [calls] error lines (see $LOG/prod)"
grep -q 'boot failed' "$LOG/prod" && fail "boot failed in prod logs" || true
fb=$(grep -oE 'freeBytes=[0-9]+' "$LOG/prod" | tail -1 | cut -d= -f2); [[ -n "$fb" && "$fb" -lt 1073741824 ]] && warn "prod /data volume free ${fb} bytes (<1 GB)"

echo; [[ $FAIL == 0 ]] && echo "GATE: PASS (logs $LOG)" || echo "GATE: FAIL (logs $LOG)"; exit $FAIL
