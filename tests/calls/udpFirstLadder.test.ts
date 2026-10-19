import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ADAPT, LADDER, NetLadder, videoBpsFor } from "../../src/lib/calls/netAdapt";
import { udpOnlyResult } from "../../server/calls/index";

const eng = readFileSync("src/lib/calls/engine.ts", "utf8");
const srv = readFileSync("server/calls/index.ts", "utf8");
const ms = readFileSync("src/lib/calls/mediasoupSession.ts", "utf8");
const good = { lossPercent: 0, rttMs: 50, outKbps: 2000, reasons: [] as string[] };
const severe = { lossPercent: 20, rttMs: 300, outKbps: 500, reasons: ["loss"] };

test("thresholds: 1 s sampling, down after 2 s, up after 8 s steady, severe = >15 % loss", () => {
  assert.equal(ADAPT.sampleMs, 1_000);
  assert.equal(ADAPT.downAfter, 2);
  assert.equal(ADAPT.upAfter, 8);
  assert.equal(ADAPT.severeLossPercent, 15);
  assert.equal(ADAPT.reconnectLevel, 1);
});

test("severe loss: floor within 2 s (audio first), reconnect after ~5 s sustained", () => {
  const l = new NetLadder();
  const acts = Array.from({ length: 5 }, () => l.push(severe));
  assert.equal(acts[1].type, "step");
  assert.equal(l.level, LADDER.length - 1);
  assert.equal(acts[4].type, "tcp", "reconnect flow after 2 + 3 severe samples");
});

test("ramp up: one rung per 8 steady seconds from the conservative reconnect rung", () => {
  const l = new NetLadder();
  l.reset(ADAPT.reconnectLevel);
  const acts = Array.from({ length: 8 }, () => l.push(good));
  assert.equal(acts.filter((a) => a.type === "step").length, 1);
  assert.equal(l.level, 0);
});

test("video bitrate tracks availableOutgoingBitrate within the rung, never below the floor, audio first", () => {
  assert.equal(videoBpsFor(LADDER[0], null), LADDER[0].videoBps);
  assert.equal(videoBpsFor(LADDER[0], 600), Math.floor(600_000 * 0.85) - LADDER[0].audioBps);
  assert.equal(videoBpsFor(LADDER[0], 50), ADAPT.minVideoBps);
  assert.equal(videoBpsFor(LADDER[0], 100_000), LADDER[0].videoBps);
});

test("path order: SFU ICE-TCP candidates stripped (UDP direct first), our TURNS relay offered", () => {
  const r = udpOnlyResult("transport:create", { transport: { id: "t", iceCandidates: [{ protocol: "udp" }, { protocol: "tcp" }] } }) as { transport: { iceCandidates: unknown[] } };
  assert.deepEqual(r.transport.iceCandidates, [{ protocol: "udp" }]);
  assert.deepEqual(udpOnlyResult("produce", { id: "p" }), { id: "p" });
  assert.match(srv, /mintTurnIceServers\(callId, userId\)\?\.map[\s\S]{0,200}startsWith\("turns:"\)/);
});

test("first connect (5:44): silent retries within a 5 s budget, no Reconnecting UI, transient states ignored, then silent LiveKit", () => {
  assert.match(eng, /if \(!recovering && !this\.inFirstRetry\) void this\.retryFirstConnect\(/);
  assert.match(eng, /FIRST_CONNECT_BUDGET_MS = 5_000;/);
  const rf = eng.slice(eng.indexOf("private async retryFirstConnect("), eng.indexOf("private async lastResortLiveKit("));
  assert.doesNotMatch(rf, /reconnecting: true/);
  assert.match(rf, /await this\.lastResortLiveKit\("first-connect"/);
  assert.match(eng, /if \(!this\.msRecoveryOnly\(\)\) \{\s*this\.netLog\(`ms-\$\{state\}-first`\);\s*return;/);
  const lk = eng.slice(eng.indexOf("private async lastResortLiveKit("), eng.indexOf("private failUdpUnreachable("));
  assert.doesNotMatch(lk, /reconnecting: true/);
  assert.match(lk, /"call:mediaFallback"/);
  assert.match(lk, /if \(this\.iosNativeVideoOwnsCamera\(\)\) return void this\.iosNativeVideoToWebView\(/,
    "a granted iPhone native-video call returns to WebView media before a disabled LiveKit fallback can end it");
  assert.match(lk, /this\.failUdpUnreachable\(stage/, "ordinary calls retain the terminal UDP fallback");
  assert.match(eng, /MS_RECOVER_MAX_MS\) \{[\s\S]{0,120}lastResortLiveKit\("recover-timeout"/);
  assert.match(eng, /Can't connect the call on this network\. Try another Wi-Fi or mobile data\./);
});

test("failure telemetry: client diag events + server logs refused SFU steps", () => {
  assert.match(eng, /"ms-connect-failed", \{ recovering, reason:/);
  assert.match(eng, /this\.socket\.emit\("call:diag"/);
  assert.match(srv, /socket\.on\("call:diag"/);
  assert.match(srv, /\[calls\] media request failed/);
});

test("web mid-call video: produce/close on the EXISTING send transport (no new transport / ICE restart)", () => {
  assert.match(eng, /if \(on\) await this\.mediasoup\.enableCamera\(this\.s\.facing\);\s*else await this\.mediasoup\.disableCamera\(\);/);
  const en = ms.slice(ms.indexOf("async enableCamera("), ms.indexOf("async disableCamera("));
  assert.match(en, /this\.send\.produce\(/);
  assert.doesNotMatch(en, /createSendTransport|restartIce/);
  assert.match(ms, /async disableCamera\(\) \{\s*this\.producers\.get\("video"\)\?\.close\(\);/);
});

test("launch: silent permissions.query only (no prompt)", () => {
  const p = readFileSync("src/lib/calls/permissions/index.ts", "utf8");
  assert.match(p, /checkMediaPermissionsSilently[\s\S]{0,600}permissions[\s\S]{0,200}\.query\(/);
  assert.doesNotMatch(p.slice(p.indexOf("checkMediaPermissionsSilently")), /getUserMedia/);
  assert.match(readFileSync("src/components/calls/CallProvider.tsx", "utf8"), /useEffect\(\(\) => void checkMediaPermissionsSilently\(\)/);
});

test("apps: native voice stays camera-free while an explicit native-video grant retains its established camera controls", () => {
  const ov = readFileSync("src/components/calls/CallOverlay.tsx", "utf8");
  assert.match(ov, /\{s\.nativeAudio && !s\.nativeVideo \? null : \(\s*<RoundBtn label=\{s\.camOn \? "Stop video" : "Video"\}/);
  assert.match(ov, /s\.videoInvite && !s\.camOn && !\(s\.nativeAudio && !s\.nativeVideo\) && active/);
  assert.match(eng, /const nativeVideo = appOwnedMedia && media\.iosNativeVideo === true;[\s\S]{0,200}this\.set\(\{ nativeAudio: appOwnedMedia, nativeVideo \}\)/);
});

test("speaker (6:20): toggle offered on web-path calls, default route video=speaker/voice=earpiece, Flip kept beside it; audio telemetry", () => {
  const ov = readFileSync("src/components/calls/CallOverlay.tsx", "utf8");
  assert.match(ov, /s\.speakerSupported \? \(\s*<RoundBtn label="Speaker"[\s\S]{0,300}\) : null\}\s*\{s\.camOn \? \(\s*<RoundBtn label="Flip"/);
  assert.match(eng, /if \(firstMediaOk\) this\.initCallRoute\(\);/);
  assert.match(eng, /const speaker = !!\(this\.s\.camOn \|\| this\.s\.call\?\.video\);[\s\S]{0,120}postNative\(\{ type: "call:audioRoute", speaker \}\)/);
  assert.match(eng, /this\.diag\("remote-audio-play-failed"/);
  assert.match(eng, /this\.diag\("audio-levels"/);
});
