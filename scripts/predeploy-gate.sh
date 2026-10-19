#!/usr/bin/env bash
# Pre-deploy regression gate (Open Lounge). Read-only against prod: no deploys, no restarts, no calls placed.
# Usage: scripts/predeploy-gate.sh [--skip-build] [--live]
# --live: signs in the 3 existing test accounts (testverifier2, Jordan, Sam) and places short prod test calls between them only.
# Env: PG_TEST_BASE (default postgresql://ua@127.0.0.1:55433), RAILWAY_SERVICE, RAILWAY_ENV
set -uo pipefail
cd "$(dirname "$0")/.."
SVC=${RAILWAY_SERVICE:-85ca960c-3d16-4435-aca2-b19982673dd6}
ENVID=${RAILWAY_ENV:-6f0c8313-dbc9-46ba-af56-e7ad1cef830f}
PGB=${PG_TEST_BASE:-postgresql://ua@127.0.0.1:55433}
SKIP_BUILD=0; LIVE=0
for a in "$@"; do [[ $a == --skip-build ]] && SKIP_BUILD=1; [[ $a == --live ]] && LIVE=1; done
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


echo "== 2b. pipeline stage coverage (calls suite, must have >=1 ok and 0 not ok)"
stage(){ n=$(grep -iE "^ *ok [0-9]+ - .*($2)" "$LOG/calls" | wc -l); bad=$(grep -iE "^ *not ok [0-9]+ - .*($2)" "$LOG/calls" | wc -l)
  [[ $n -gt 0 && $bad == 0 ]] && pass "stage $1 ($n ok)" || fail "stage $1 ok=$n notok=$bad"; }
stage ring/push "ring|push|voip|fcm"
stage background-wake "background|hidden|appVisible|app lock"
stage connect-tcp-fallback "tcp"
stage livekit-fallback "livekit"
stage ice-restart "ice restart|ice down|outage"
stage no-audio-recovery "stall|black-hole|no inbound|mic recovery|muted mic"
stage quality-guard "quality guard|loss|bandwidth"
stage busy-redial "busy"
stage hangup-ended "ended|hang up|cancelled"
stage native-media "native"
stage audio-processing "aec|agc|microphone|ringtone"

echo "== 3. Chatswop isolation"
if git diff --name-only "$PROD" HEAD | grep -qiE 'chatswop|camerax'; then fail "diff touches Chatswop/CameraX paths"; else pass "no Chatswop/CameraX code in diff vs prod (separate repo)"; fi

echo "== 4. prod read-only probes"
for p in healthz readyz; do c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://openlounge.app/$p); [[ $c == 200 ]] && pass "/$p 200" || fail "/$p $c"; done
node -e 'const W=require("ws");const w=new W("wss://openlounge.app/ws",{headers:{Origin:"https://openlounge.app"}});const t=setTimeout(()=>process.exit(1),8000);w.on("open",()=>{w.close();process.exit(0)});w.on("error",()=>process.exit(1));w.on("unexpected-response",()=>process.exit(1))' && pass "wss upgrade" || fail "wss upgrade"
timeout 8 openssl s_client -connect turn.openlounge.app:443 -servername turn.openlounge.app </dev/null 2>/dev/null | grep -q "Verify return code: 0" && pass "TURN TLS :443 cert ok" || fail "TURN TLS :443"
timeout 6 bash -c '</dev/tcp/165.232.137.71/40443' 2>/dev/null && pass "mediasoup TCP 40443 open" || fail "mediasoup TCP 40443"
c=$(curl -sI -o /dev/null -w '%{http_code}' --max-time 10 https://openlounge.app/downloads/openlounge-0.3.18-34.apk); [[ $c == 200 ]] && pass "APK 0.3.18-34 served" || fail "APK $c"


echo "== 4b. native shells (static, read-only; no builds)"
AND=${AND_REPO:-/workspace/and-loud}; MF="$AND/app/src/main/AndroidManifest.xml"
if [[ -f "$MF" ]]; then
  for k in USE_FULL_SCREEN_INTENT FOREGROUND_SERVICE_PHONE_CALL 'foregroundServiceType="phoneCall'; do grep -q "$k" "$MF" && pass "Android manifest $k" || fail "Android manifest missing $k"; done
else warn "Android repo not found ($AND)"; fi
IOS=${IOS_REPO:-/workspace/ios-r2}
[[ -d "$IOS" ]] && { grep -rqs "reportNewIncomingCall" "$IOS/modules" && pass "iOS CallKit reportNewIncomingCall present ($IOS)" || fail "iOS CallKit missing in $IOS"; } || warn "iOS repo not found"

echo "== 4c. Chatswop backend (read-only probe, no auth, no calls)"
CS=${CS_BACKEND:-http://165.227.89.227:3030}
c=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$CS/socket.io/?EIO=4&transport=polling"); [[ $c == 200 ]] && pass "Chatswop socket.io handshake 200" || fail "Chatswop socket.io $c"


echo "== 4d. Chatswop call code (static, read-only; known gaps reported as FAIL until fixed)"
CSA=${CS_ANDROID:-/workspace/chatswop-android-kotlin-sydney}; CSI=${CS_IOS:-/workspace/chatswop-ios-app}
if [[ -d "$CSA" ]]; then
  V="$CSA/app/src/main/java/com/globalnetwork/chatswop/webrtc/VideoCallActivity.kt"
  grep -qE 'setEnableSpeakerphone\(onSpeakerPhone: Boolean\) *\{ *\}' "$V" && fail "Chatswop Android: video-call speaker toggle is a no-op" || pass "Chatswop Android: video speaker implemented"
  grep -q "io.agora" "$CSA/app/build.gradle" && warn "Chatswop Android: Agora 3.6.0.1 still a dependency (fork drift)" || pass "Chatswop Android: no Agora"
  m=$(rg -l "MODE_IN_COMMUNICATION" "$CSA/app/src/main/java" | wc -l); r=$(rg -l "MODE_NORMAL" "$CSA/app/src/main/java" | wc -l)
  [[ $r -ge $m ]] && pass "Chatswop Android: audio mode set/restore paired ($m/$r files)" || fail "Chatswop Android: MODE_IN_COMMUNICATION in $m files, MODE_NORMAL restore in $r"
fi
if [[ -d "$CSI" ]]; then
  grep -rqs "reportNewIncomingCall" "$CSI/ChatSwap" && pass "Chatswop iOS: CallKit incoming present (repo $CSI)" || fail "Chatswop iOS: no CallKit"
  grep -rqs "PKPushRegistry" "$CSI/ChatSwap" && pass "Chatswop iOS: PushKit registry present" || fail "Chatswop iOS: no PushKit"
fi

echo "== 5. prod [calls] log scan (current deployment)"
timeout 120 railway logs -s "$SVC" -e "$ENVID" -n 5000 >"$LOG/prod" 2>/dev/null
C=$(grep -c '\[calls\]' "$LOG/prod"); echo "   [calls] lines: $C"
for k in "native=true" "native-fallback-webview" "ring-retry\|repush" "busy" "livekit"; do echo "   $k: $(grep '\[calls\]' "$LOG/prod" | grep -c "$k")"; done
E=$(grep -E '\[calls\]|"calls' "$LOG/prod" | grep -ciE 'level="?error|uncaught|unhandled|exception')
[[ $E == 0 ]] && pass "no [calls] errors" || fail "$E [calls] error lines (see $LOG/prod)"
grep -q 'boot failed' "$LOG/prod" && fail "boot failed in prod logs" || true
fb=$(grep -oE 'freeBytes=[0-9]+' "$LOG/prod" | tail -1 | cut -d= -f2); [[ -n "$fb" && "$fb" -lt 1073741824 ]] && warn "prod /data volume free ${fb} bytes (<1 GB)"

if [[ $LIVE == 1 ]]; then
  echo "== 6. LIVE two-party call smoke on prod (test accounts only)"
  node scripts/live-call-login.mjs >"$LOG/live-login" 2>&1; cat "$LOG/live-login"
  node scripts/live-call-smoke.mjs 2>&1 | tee "$LOG/live" | grep -E "^(PASS|FAIL)|LIVE:"; [[ ${PIPESTATUS[0]} == 0 ]] || FAIL=1
  sleep 5; timeout 90 railway logs -s "$SVC" -e "$ENVID" -n 2000 >"$LOG/live-prod" 2>/dev/null
  for k in "call ring ack" "call accept" "first-audio" "call busy" "call end"; do echo "   prod log '$k': $(grep -c "$k" "$LOG/live-prod")"; done
fi

echo; [[ $FAIL == 0 ]] && echo "GATE: PASS (logs $LOG)" || echo "GATE: FAIL (logs $LOG)"; exit $FAIL
