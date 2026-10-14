// Hallway announcement must not fire for blips / backgrounded silent reconnects.
process.env.PRESENCE_CLOSE_GRACE_MS = "50";
process.env.PRESENCE_HIDDEN_GRACE_MS = "50";
process.env.PRESENCE_AWAY_GRACE_MS = "30";
process.env.PRESENCE_HALLWAY_CONFIRM_MS = "150";
process.env.PRESENCE_HALLWAY_MIN_ABSENCE_MS = "1000";
import { test } from "node:test";
import assert from "node:assert/strict";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Presence } = require("../../server/presence") as typeof import("../../server/presence");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function make(seed = new Map<string, number>()) {
  const fired: string[] = [];
  const hub = { to: () => ({ emit: () => {} }) } as any;
  const p = new Presence(hub, () => false, () => {}, seed, (u) => fired.push(u));
  return { p, fired };
}

test("stays online past confirm after long absence → announced once", async () => {
  const { p, fired } = make(new Map([["k", Date.now() - 60_000]]));
  p.attach("c1", "k", "t");
  assert.deepEqual(fired, []);
  await sleep(200);
  assert.deepEqual(fired, ["k"]);
  p.stop();
});

test("backgrounded app silently reconnects then reports hidden → NOT announced", async () => {
  const { p, fired } = make(new Map([["k", Date.now() - 60_000]]));
  p.attach("c1", "k", "t");
  p.setVisible("c1", false);
  await sleep(250);
  assert.equal(p.statusOf("k"), "away");
  assert.deepEqual(fired, []);
  p.stop();
});

test("socket blip / reconnect shortly after leaving → NOT announced", async () => {
  const { p, fired } = make(new Map([["k", Date.now() - 60_000]]));
  p.attach("c1", "k", "t");
  await sleep(200);
  assert.equal(fired.length, 1);
  p.detach("c1");
  await sleep(100);
  assert.equal(p.statusOf("k"), "offline");
  p.attach("c2", "k", "t");
  await sleep(250);
  assert.equal(fired.length, 1);
  p.stop();
});
