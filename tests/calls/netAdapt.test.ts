import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ADAPT, LADDER, NetLadder, nativeAdaptiveEnabled } from "../../src/lib/calls/netAdapt";

const good = { lossPercent: 0, rttMs: 60, outKbps: 2000, reasons: [] as string[] };
const lossy = { lossPercent: 7, rttMs: 120, outKbps: 300, reasons: [] as string[] };
const severe = { lossPercent: 25, rttMs: 300, outKbps: 18, reasons: ["loss", "bandwidth"] };

test("gate: only the native wrappers (bridge getPlatform android|ios) enable adaptation", () => {
  assert.equal(nativeAdaptiveEnabled("android"), true);
  assert.equal(nativeAdaptiveEnabled("ios"), true);
  assert.equal(nativeAdaptiveEnabled(null), false); // desktop web + mobile browsers
  // default argument reads the bridge; in node there is no window → disabled
  assert.equal(nativeAdaptiveEnabled(), false);
});

test("gate: no UA sniffing in the gate or ladder", () => {
  const src = readFileSync(new URL("../../src/lib/calls/netAdapt.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /userAgent|matchMedia|ontouchstart|innerWidth/);
});

test("engine: ladder, MBB parking and in-place ICE on network change are all behind the one gate", () => {
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.match(src, /if \(nativeAdaptiveEnabled\(\)\) return this\.startNetLadder\(session\)/);
  assert.match(src, /if \(nativeAdaptiveEnabled\(\)\) this\.parkMediaForSwitch\(\)/);
  assert.match(src, /this\.mediasoup && nativeAdaptiveEnabled\(\)/);
});

test("ladder: steady good stays at L0", () => {
  const l = new NetLadder();
  for (let i = 0; i < 20; i++) assert.equal(l.push(good).type, "none");
  assert.equal(l.level, 0);
});

test("ladder: a single bad sample never steps (hysteresis)", () => {
  const l = new NetLadder();
  assert.equal(l.push(lossy).type, "none");
  assert.equal(l.push(good).type, "none");
  assert.equal(l.level, 0);
});

test("ladder: lossy steps down one rung per downAfter samples, audio+video together", () => {
  const l = new NetLadder();
  const acts = Array.from({ length: ADAPT.downAfter }, () => l.push(lossy));
  const last = acts.at(-1)!;
  assert.equal(last.type, "step");
  if (last.type === "step") {
    assert.equal(last.level, 1);
    assert.equal(last.step.audioBps, LADDER[1].audioBps);
    assert.ok(last.step.videoScale > 1 && last.step.videoFps < 30);
  }
});

test("ladder: severe skips to the floor fast, then TCP only after tcpAfter floor samples", () => {
  const l = new NetLadder();
  let samples = 0;
  while (l.level < LADDER.length - 1) {
    l.push(severe);
    samples++;
    assert.ok(samples < 10);
  }
  assert.ok(samples <= 2 * ADAPT.downAfter, `reached floor in ${samples} samples`);
  const acts = Array.from({ length: ADAPT.tcpAfter }, () => l.push(severe));
  assert.deepEqual(acts.slice(0, -1).map((a) => a.type), Array(ADAPT.tcpAfter - 1).fill("none"));
  assert.equal(acts.at(-1)!.type, "tcp");
});

test("ladder: bitrate degrades before TCP — never TCP above the floor", () => {
  const l = new NetLadder();
  for (let i = 0; i < 3; i++) assert.notEqual(l.push(severe).type, "tcp");
});

test("ladder: recovers one rung per upAfter good samples", () => {
  const l = new NetLadder();
  l.reset(3);
  let ups = 0;
  for (let i = 0; i < ADAPT.upAfter * 3; i++) if (l.push(good).type === "step") ups++;
  assert.equal(ups, 3);
  assert.equal(l.level, 0);
});

test("ladder: no flap on alternating good/bad", () => {
  const l = new NetLadder();
  for (let i = 0; i < 30; i++) l.push(i % 2 ? good : lossy);
  assert.equal(l.level, 0);
});
