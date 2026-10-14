// Presence state machine: fast flips, accurate snapshots, monotonic single-source lastSeenAt.
process.env.PRESENCE_CLOSE_GRACE_MS = "200";
process.env.PRESENCE_HIDDEN_GRACE_MS = "300";
process.env.PRESENCE_AWAY_GRACE_MS = "100";
process.env.PRESENCE_SWEEP_MS = "250";
process.env.PRESENCE_HALLWAY_ONLINE_GRACE_MS = "50";
import { test } from "node:test";
import assert from "node:assert/strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Presence, HIDDEN_GRACE_MS, SWEEP_MS } = require("../../server/presence") as typeof import("../../server/presence");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(seed = new Map<string, number>(), onBecameOnline: ((userId: string) => void) | null = null) {
  const events: any[] = [];
  const persisted: [string, number][] = [];
  const hub = { to: () => ({ emit: (_e: string, u: unknown) => events.push(u) }) } as any;
  const p = new Presence(hub, () => false, (t, at) => persisted.push([t, at]), seed, onBecameOnline);
  return { p, events, persisted };
}

test("defaults: hidden grace and sweep are a few seconds, not minutes", async () => {
  // values here come from env; check the source defaults too
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../server/presence.ts"), "utf8");
  assert.match(src, /PRESENCE_HIDDEN_GRACE_MS", 2_000/);
  assert.match(src, /PRESENCE_SWEEP_MS", 2_000/);
  assert.equal(HIDDEN_GRACE_MS, 300);
  assert.equal(SWEEP_MS, 250);
});

test("confirmed foreground connection flips online; last socket close flips offline after the short grace", async () => {
  const { p, events } = make();
  p.attach("c1", "u1", "tok");
  assert.equal(p.statusOf("u1"), "offline", "a raw socket does not create a hallway presence dot");
  p.setVisible("c1", true);
  assert.equal(p.statusOf("u1"), "online");
  assert.equal(events.at(-1).status, "online");
  assert.equal(typeof events.at(-1).now, "number");
  const t0 = Date.now();
  p.detach("c1");
  await sleep(260);
  assert.equal(p.statusOf("u1"), "offline");
  const off = events.at(-1);
  assert.equal(off.status, "offline");
  assert.ok(off.lastSeenAt >= t0 && off.lastSeenAt <= t0 + 20, "lastSeenAt = disconnect time");
  p.stop();
});

test("backgrounded reconnect stays offline until visibility is confirmed and announces only after stable foreground", async () => {
  const announced: string[] = [];
  const { p, events } = make(new Map(), (userId) => announced.push(userId));
  p.attach("c1", "u1", "tok");
  assert.equal(p.statusOf("u1"), "offline");
  assert.equal(events.length, 0);
  assert.deepEqual(announced, []);

  p.setVisible("c1", false);
  assert.equal(p.statusOf("u1"), "away", "an explicitly backgrounded app is away, not online");
  assert.deepEqual(announced, []);

  p.setVisible("c1", true);
  assert.equal(p.statusOf("u1"), "online");
  assert.deepEqual(announced, [], "the stability window must elapse before the hallway callback");
  await sleep(70);
  assert.deepEqual(announced, ["u1"], "only a confirmed foreground state announces hallway presence");
  p.setVisible("c1", true);
  assert.deepEqual(announced, ["u1"], "duplicate foreground reports do not re-announce");
  p.stop();
});

test("brief reconnect foreground confirmation is cancelled before it can announce hallway presence", async () => {
  const announced: string[] = [];
  const { p } = make(new Map(), (userId) => announced.push(userId));
  p.attach("c1", "u1", "tok");
  p.setVisible("c1", true);
  await sleep(20);
  p.setVisible("c1", false);
  await sleep(120);
  assert.equal(p.statusOf("u1"), "away");
  assert.deepEqual(announced, []);
  p.stop();
});

test("backgrounded socket that dies goes offline in seconds (no 120 s amber)", async () => {
  const { p } = make();
  p.attach("c1", "u1", "tok");
  p.setVisible("c1", true);
  p.setVisible("c1", false);
  await sleep(150);
  assert.equal(p.statusOf("u1"), "away");
  p.detach("c1");
  await sleep(400);
  assert.equal(p.statusOf("u1"), "offline");
  p.stop();
});

test("multi-tab: closing the confirmed foreground tab cannot leave an unconfirmed sibling green", async () => {
  const { p } = make();
  p.attach("a", "u1", "tok");
  p.attach("b", "u1", "tok");
  p.setVisible("a", true);
  p.detach("a");
  await sleep(260);
  assert.equal(p.statusOf("u1"), "offline");
  p.stop();
});

test("snapshot is accurate and never carries a stale lastSeen for online users", async () => {
  const { p } = make(new Map([["u1", 1000], ["u2", 2000]]));
  p.attach("c1", "u1", "tok");
  p.setVisible("c1", true);
  const s = p.snapshot();
  assert.deepEqual(s.onlineIds, ["u1"]);
  assert.equal(s.lastSeen.u1, undefined);
  assert.equal(s.lastSeen.u2, 2000);
  assert.ok(Math.abs(s.now - Date.now()) < 50);
  p.stop();
});

test("lastSeenAt never moves backwards and an activity (read receipt) bumps it", async () => {
  const future = Date.now() + 60_000;
  const { p, events } = make(new Map([["u1", future]]));
  p.attach("c1", "u1", "tok");
  p.setVisible("c1", true);
  p.detach("c1");
  await sleep(260);
  assert.equal(p.lastSeenAt("u1"), future, "seeded newer value kept");
  const { p: q, events: ev2, persisted } = make();
  q.attach("c1", "u1", "tok");
  q.setVisible("c1", true);
  q.setVisible("c1", false);
  await sleep(150);
  const awayAt = q.lastSeenAt("u1")!;
  await sleep(30);
  const readAt = Date.now();
  q.activity("u1", readAt); // dm:read from the backgrounded app
  assert.equal(q.lastSeenAt("u1"), readAt);
  assert.ok(readAt > awayAt);
  assert.equal(ev2.at(-1).lastSeenAt, readAt);
  assert.deepEqual(persisted.at(-1), ["tok", readAt]);
  q.activity("u1", readAt - 5000);
  assert.equal(q.lastSeenAt("u1"), readAt, "older activity ignored");
  void events;
  p.stop();
  q.stop();
});

test("generic interaction bump is throttled to one persist+broadcast per window; online is a no-op", async () => {
  const { p, events, persisted } = make();
  p.attach("c1", "u1", "tok");
  p.setVisible("c1", true);
  const n0 = events.length;
  p.activity("u1", Date.now(), 10_000);
  assert.equal(events.length, n0, "online: nothing");
  p.setVisible("c1", false);
  await sleep(150);
  const base = p.lastSeenAt("u1")!;
  const n1 = persisted.length;
  p.activity("u1", base + 5_000, 10_000);
  assert.equal(p.lastSeenAt("u1"), base, "within window: throttled");
  p.activity("u1", base + 10_001, 10_000);
  assert.equal(p.lastSeenAt("u1"), base + 10_001);
  assert.equal(persisted.length, n1 + 1);
  p.stop();
});
