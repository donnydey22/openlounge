import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { countersFromStats, judgeQuality } from "../../src/lib/calls/qualityGuard";
import { NetLadder } from "../../src/lib/calls/netAdapt";

const rep = (inLost: number, inRx: number, sent: number, remoteLost: number) =>
  new Map<string, Record<string, unknown>>([
    ["i", { type: "inbound-rtp", kind: "audio", packetsReceived: inRx, packetsLost: inLost, bytesReceived: inRx * 100 }],
    ["o", { type: "outbound-rtp", kind: "audio", packetsSent: sent }],
    ["r", { type: "remote-inbound-rtp", kind: "audio", packetsLost: remoteLost }],
  ]);

test("Keiko pattern: heavy inbound loss, clean uplink → send ladder stays at full quality", () => {
  const l = new NetLadder();
  let prev = countersFromStats([rep(0, 0, 0, 0)], 0);
  for (let i = 1; i <= 10; i++) {
    const cur = countersFromStats([rep(i * 30, i * 20, i * 50, 0)], i * 1000); // 60 % inbound loss, 0 % uplink
    const v = judgeQuality(prev, cur, { lossFrom: "uplink" });
    assert.equal(v.lossPercent, 0);
    assert.equal(l.push(v).type, "none");
    prev = cur;
  }
  assert.equal(l.level, 0);
});

test("real uplink loss still steps the send ladder down", () => {
  const l = new NetLadder();
  let prev = countersFromStats([rep(0, 0, 0, 0)], 0);
  const acts: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const cur = countersFromStats([rep(0, i * 50, i * 50, i * 5)], i * 1000); // 10 % uplink loss
    acts.push(l.push(judgeQuality(prev, cur, { lossFrom: "uplink" })).type);
    prev = cur;
  }
  assert.ok(acts.includes("step"));
  assert.ok(l.level > 0);
});

test("default (inbound) verdict unchanged for the audibility guard", () => {
  const v = judgeQuality(countersFromStats([rep(0, 0, 0, 0)], 0), countersFromStats([rep(30, 20, 50, 0)], 1000));
  assert.equal(v.lossPercent, 60);
});

test("engine send ladder uses uplink loss", () => {
  assert.match(readFileSync("src/lib/calls/engine.ts", "utf8"), /lossFrom: "uplink"/);
});
