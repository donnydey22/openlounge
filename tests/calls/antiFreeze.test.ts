// FX-079 must-pass: the video feed does its best never to freeze (Donny, Oct 24 2026 8:13 PM MST).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ANTI_FREEZE, FrozenFrameWatchdog, antiFreezeFps } from "../../src/lib/calls/antiFreeze";
import { LADDER } from "../../src/lib/calls/netAdapt";

test("frame-rate floor: no ladder rung sends below the floor (30dc469c bottom rung was 8 fps)", () => {
  for (const r of LADDER) assert.ok(antiFreezeFps(r.videoFps) >= ANTI_FREEZE.minFps);
  assert.equal(antiFreezeFps(30), 30);
});

test("watchdog: keyframe at ~1.5 s, re-resume at ~4 s, re-sync at ~8 s, reset on a new frame", () => {
  const d = new FrozenFrameWatchdog();
  const acts: Array<[number, string]> = [];
  let frames = 0;
  for (let t = 0; t <= 10_500; t += 500) {
    if (t <= 2_000) frames++;
    const a = d.push(t, frames);
    if (a) acts.push([t - 2_000, a]);
  }
  assert.deepEqual(acts.map((x) => x[1]), ["keyframe", "resume", "resync"]);
  assert.ok(acts[0][0] >= 1_500 && acts[0][0] <= 2_000, `keyframe after ${acts[0][0]} ms`);
  assert.equal(d.push(11_000, frames + 1), null); // new frame: recovered
  assert.equal(d.push(11_500, frames + 2), null);
});

test("bbbe198f replay: peer network drop 8:10:19 PM → watchdog asks for recovery instead of waiting it out", () => {
  const d = new FrozenFrameWatchdog(); let f = 0; const acts: string[] = [];
  for (let t = 0; t < 55_000; t += 500) { if (t < 40_000) f++; const a = d.push(t, f); if (a) acts.push(a); }
  assert.ok(acts.includes("keyframe") && acts.includes("resume") && acts.includes("resync"));
  assert.ok(acts.filter((a) => a === "keyframe").length >= 1);
});

test("wiring: sender prefers frame rate, engine runs the watchdog, SFU + server expose keyframe requests", () => {
  const ms = readFileSync(new URL("../../src/lib/calls/mediasoupSession.ts", import.meta.url), "utf8");
  assert.match(ms, /e\.maxFramerate = antiFreezeFps\(step\.videoFps\)/);
  assert.match(ms, /p\.degradationPreference = ANTI_FREEZE\.degradationPreference/);
  assert.match(ms, /"ms:consumer:requestKeyFrame"/);
  const en = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.match(en, /const stopFreeze = this\.watchFrozenVideo\(receiver\)/);
  assert.match(en, /receiver\.track\?\.muted\) return;/);
  const sfu = readFileSync(new URL("../../media-sfu/src/index.mjs", import.meta.url), "utf8");
  assert.match(sfu, /method === "consumer:requestKeyFrame"[\s\S]{0,300}consumer\.requestKeyFrame\(\)/);
  const srv = readFileSync(new URL("../../server/calls/index.ts", import.meta.url), "utf8");
  assert.match(srv, /socket\.on\("ms:consumer:requestKeyFrame", relay\("consumer:requestKeyFrame"\)\)/);
});
