// FX-080 must-pass: 3-layer simulcast + SFU preferred-layer switching (Donny, Oct 24 2026 8:51 PM MST).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SIMULCAST_LAYERS, cameraEncodings, simulcastLadderPatch } from "../../src/lib/calls/simulcast";
import { ANTI_FREEZE } from "../../src/lib/calls/antiFreeze";
import { LADDER } from "../../src/lib/calls/netAdapt";
// @ts-expect-error plain .mjs
import { LAYER_POLICY, nextLayer } from "../../media-sfu/src/layers.mjs";

test("simulcast: three ascending layers (low/mid/high), every layer at or above the FX-079 fps floor", () => {
  const e = cameraEncodings(true)!;
  assert.equal(e.length, 3);
  assert.deepEqual(e.map((x) => x.scaleResolutionDownBy), [4, 2, 1]);
  for (let i = 1; i < 3; i++) assert.ok(e[i].maxBitrate! > e[i - 1].maxBitrate!);
  for (const x of e) assert.ok(x.maxFramerate! >= ANTI_FREEZE.minFps);
  assert.equal(cameraEncodings(false), undefined, "flag off = proven single encoding, unchanged");
});

test("simulcast ladder: low layer always on, upper layers switch on only when they fit the rung", () => {
  for (const step of LADDER) {
    const e = simulcastLadderPatch(cameraEncodings(true)!, step);
    assert.equal(e[0].active, true);
    assert.ok(e[0].maxFramerate! >= ANTI_FREEZE.minFps);
    const sent = e.filter((x) => x.active).reduce((a, x) => a + x.maxBitrate!, 0);
    assert.ok(sent <= Math.max(step.videoBps, SIMULCAST_LAYERS[0].maxBitrate), `rung ${step.videoBps}: ${sent}`);
  }
  const top = simulcastLadderPatch(cameraEncodings(true)!, LADDER[0]);
  assert.deepEqual(top.map((x) => x.active), [true, true, false]); // 1.2 M rung: low+mid; high needs > 1.75 M total
  const floor = simulcastLadderPatch(cameraEncodings(true)!, LADDER[LADDER.length - 1]);
  assert.deepEqual(floor.map((x) => x.active), [true, false, false]);
});

test("SFU layer policy: severe loss -> low at once; 2 lossy samples -> one down; 3 clean -> one up; BWE ceiling", () => {
  let s = nextLayer(undefined, { lossPct: 0, availableBps: 5e6 });
  assert.equal(s.spatial, 2);
  s = nextLayer(s, { lossPct: 25, availableBps: 5e6 });
  assert.equal(s.spatial, 0);
  for (let i = 0; i < LAYER_POLICY.upAfter; i++) s = nextLayer(s, { lossPct: 0, availableBps: 5e6 });
  assert.equal(s.spatial, 1);
  s = nextLayer(s, { lossPct: 10, availableBps: 5e6 }); assert.equal(s.spatial, 1);
  s = nextLayer(s, { lossPct: 10, availableBps: 5e6 }); assert.equal(s.spatial, 0);
  assert.equal(nextLayer({ spatial: 2, bad: 0, good: 0 }, { lossPct: 0, availableBps: 300_000 }).spatial, 0);
  assert.equal(nextLayer({ spatial: 2, bad: 0, good: 0 }, { lossPct: 0, availableBps: 600_000 }).spatial, 1);
});

test("wiring: SFU steers only simulcast consumers and never closes anything", () => {
  const sfu = readFileSync(new URL("../../media-sfu/src/index.mjs", import.meta.url), "utf8");
  assert.match(sfu, /c\.type === "simulcast"/);
  assert.match(sfu, /setPreferredLayers\(\{ spatialLayer: next\.spatial/);
  assert.doesNotMatch(sfu.slice(sfu.indexOf("async function steerAndReport"), sfu.indexOf("let steering")), /\.close\(\)/, "steering never closes anything");
});

test("iOS lane: page asks the native camera for simulcast only when the flag is on", () => {
  const n = readFileSync(new URL("../../src/lib/calls/nativeMediaSession.ts", import.meta.url), "utf8");
  assert.match(n, /nativeVideo && simulcastEnabled\(\) \? \{ simulcast: true \}/);
});

test("web sender (pin approval pending): camera produce passes simulcast encodings; ladder is layer-aware", () => {
  const ms = readFileSync(new URL("../../src/lib/calls/mediasoupSession.ts", import.meta.url), "utf8");
  assert.match(ms, /const encodings = cameraEncodings\(\);/);
  assert.match(ms, /simulcastLadderPatch\(p\.encodings, step\)/);
});
