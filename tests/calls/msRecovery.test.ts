// Persistent reconnecting on the SFU (Donny, Oct 15 2026): after a total outage, recovery rebuilds the mediasoup
// transports (ICE restart → recreate with backoff), UDP stays primary, and emergency LiveKit is never entered for a
// transient outage of a call whose SFU media had already worked. Covers web + native (iOS bridge / Android shim).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const eng = readFileSync("src/lib/calls/engine.ts", "utf8");
const nat = readFileSync("src/lib/calls/nativeMediaSession.ts", "utf8");
const body = (start: string, end: string) => eng.slice(eng.indexOf(start), eng.indexOf(end, eng.indexOf(start)));
const recover = body("private async recoverMediasoup(", "// ---------- reconnect ----------");
const onState = body("private onMediasoupState(", "private startQualityGuard(");

test("connectMediasoup marks the call's SFU media as having worked", () => {
  assert.match(eng, /this\.mediasoupConnected = true;\s*\n\s*this\.msEverConnected = this\.s\.call\?\.id \?\? null;/);
  assert.match(eng, /private msRecoveryOnly\(\) \{\s*\n\s*return this\.msRecovering \|\| \(!!this\.msEverConnected && this\.msEverConnected === this\.s\.call\?\.id\);/);
});

test("disconnected/failed after SFU media worked → recoverMediasoup, never requestTcpFallback/LiveKit", () => {
  const i = onState.indexOf("if (this.msRecoveryOnly())");
  assert.ok(i > 0, "recovery branch present");
  const branch = onState.slice(i, onState.indexOf("return;\n    }", i));
  assert.match(branch, /recoverMediasoup\(state\)/);
  assert.doesNotMatch(branch, /requestTcpFallback|mediaFallback/);
  assert.ok(i < onState.indexOf('if (state === "failed") return void this.requestTcpFallback()'), "checked before the first-connect fallback");
});

test("recovery: ICE restart first, then transport rebuild loop with backoff + jitter", () => {
  assert.ok(recover.indexOf("restartIceAll()") > 0);
  assert.ok(recover.indexOf("restartIceAll()") < recover.indexOf("this.connectMediasoup(media, true)"));
  assert.match(recover, /while \(live\(\)\)/);
  assert.match(recover, /MS_REBUILD_DELAYS\[Math\.min\(attempt/);
  assert.match(recover, /Math\.random\(\)/);
});

test("recovery keeps UDP primary (no tcpOnly rebuild) and never asks for emergency LiveKit", () => {
  assert.match(recover, /this\.msTcp = false;/);
  assert.doesNotMatch(recover, /connectMediasoup\(media, true, true\)/);
  assert.doesNotMatch(recover, /call:mediaFallback|requestTcpFallback/);
});

test("recovery never ends the call itself: only the server's ended state (call:get) finishes it", () => {
  assert.doesNotMatch(recover, /hangup\(/);
  assert.match(recover, /g\.call\?\.phase === "ended"[\s\S]{0,200}finishLocal/);
});

test("a failed SFU (re)connect during recovery or after media worked does not fall into LiveKit", () => {
  assert.match(eng, /const recovering = this\.msRecoveryOnly\(\);[\s\S]{0,600}if \(!recovering\) await this\.requestTcpFallback\(true\)/);
});

test("recovery follows a server-side provider move (the peer's emergency fallback) instead of fighting it", () => {
  assert.match(recover, /g\.media\.provider !== "mediasoup"[\s\S]{0,200}switchMedia\(g\.media, g\.call\)/);
});

test("LiveKit, if used, keeps retrying: web Disconnected and native LK failed both drive the rejoin loop", () => {
  assert.match(eng, /RoomEvent\.Disconnected[\s\S]{0,400}rejoin\("lk-disconnected"\)/);
  assert.match(eng, /state === "failed" && !this\.rejoining\) void this\.rejoin\("native-lk-failed"\)/);
  const rejoin = body("private async rejoin(", "private stallTimer");
  assert.doesNotMatch(rejoin, /hangup\(/);
});

test("native (iOS bridge + Android shim): page nudges the app's ICE restart and asks for fresh transports on rebuild", () => {
  assert.match(nat, /async restartIceAll\(\) \{[\s\S]{0,200}nativeMediaCmd\(\{ op: "restartIce" \}\)/);
  assert.match(nat, /rebuild: true/);
  assert.match(eng, /\.\.\.\(this\.msRecovering \? \{ rebuild: true \} : \{\}\)/);
  assert.match(nat, /OpenLoungeNativeMedia \?\? w\.OpenLoungeNative/);
});

test("quality guard / ladder never judge a dead or recovering path (black-holed ≠ bad quality)", () => {
  assert.equal((eng.match(/if \(this\.mediasoup !== session \|\| !this\.mediasoupConnected \|\| this\.msRecovering\) return;/g) ?? []).length, 2);
  assert.match(onState, /this\.stopQualityGuard\(\); \/\/ a dead path/);
});

test("after SFU media worked, requestTcpFallback degrades on the same SFU or keeps recovering — never LiveKit", () => {
  const fb = body("private async requestTcpFallback(", "private onMediaFallback");
  const gate = fb.slice(fb.indexOf("if (this.msRecoveryOnly())"), fb.indexOf("return;\n    }\n    this.fallbackInFlight = true;"));
  assert.match(gate, /switchToMediasoupTcp\(\)/);
  assert.match(gate, /recoverMediasoup\("tcp-unavailable"\)/);
  assert.doesNotMatch(gate, /call:mediaFallback/);
  assert.ok(fb.indexOf("if (this.msRecoveryOnly())") < fb.indexOf("call:mediaFallback"));
});
