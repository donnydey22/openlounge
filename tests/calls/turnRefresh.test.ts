import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TURN_REFRESH_FIRST_MS, TURN_REFRESH_EVERY_MS, TurnRefresher, onRelay } from "../../src/lib/calls/turnRefresh";

const ICE = [{ urls: ["turn:turn.openlounge.app:3478?transport=udp"], username: "u", credential: "c", credentialType: "password" as const }];
function stats(type: "relay" | "host") {
  const m = new Map<string, unknown>([
    ["T", { id: "T", type: "transport", selectedCandidatePairId: "P" }],
    ["P", { id: "P", type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R", state: "succeeded" }],
    ["L", { id: "L", type: "local-candidate", candidateType: type }],
    ["R", { id: "R", type: "remote-candidate", candidateType: "host" }],
  ]);
  return m as unknown as RTCStatsReport;
}
function harness(kind: "relay" | "host", fetchOk = true) {
  const timers: { fn: () => void; ms: number }[] = [];
  const applied: unknown[] = [];
  let restarts = 0;
  const t = () => ({ updateIceServers: async (o: { iceServers: unknown }) => void applied.push(o.iceServers), getStats: async () => stats(kind) });
  const session = { send: t(), recv: t(), restartIceAll: async () => void restarts++, lastIceRestartOk: true };
  let remembered: unknown = null;
  const r = new TurnRefresher({
    fetch: async () => (fetchOk ? ICE : null),
    session: () => session,
    remember: (i) => (remembered = i),
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: () => {},
  });
  return { r, timers, applied, get restarts() { return restarts; }, get remembered() { return remembered; } };
}

test("relay login refresh: first refresh ~8 min into the call, then every 8 min (before the 10-min login expires)", async () => {
  assert.equal(TURN_REFRESH_FIRST_MS, 8 * 60_000);
  assert.ok(TURN_REFRESH_EVERY_MS < 10 * 60_000);
  const h = harness("relay");
  h.r.start("c1");
  h.r.start("c1"); // idempotent for the same call (rebuild keeps the schedule)
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, TURN_REFRESH_FIRST_MS);
  assert.equal(await h.r.tick("c1"), true);
  assert.equal(h.timers.at(-1)!.ms, TURN_REFRESH_EVERY_MS);
});

test("relay login refresh: relayed call gets fresh login on both transports + make-before-break ICE restart", async () => {
  const h = harness("relay");
  h.r.start("c1");
  await h.r.tick("c1");
  assert.deepEqual(h.applied, [ICE, ICE]);
  assert.equal(h.restarts, 1);
  assert.deepEqual(h.remembered, ICE);
});

test("relay login refresh: direct-UDP call only gets the new login, no ICE restart (media untouched)", async () => {
  const h = harness("host");
  h.r.start("c1");
  await h.r.tick("c1");
  assert.equal(h.applied.length, 2);
  assert.equal(h.restarts, 0);
});

test("relay login refresh: failed fetch retries in 30 s; stopped/other call never refreshes", async () => {
  const h = harness("relay", false);
  h.r.start("c1");
  assert.equal(await h.r.tick("c1"), false);
  assert.equal(h.timers.at(-1)!.ms, 30_000);
  h.r.stop();
  assert.equal(await h.r.tick("c1"), false);
  assert.equal(h.applied.length, 0);
});

test("relay login refresh: onRelay detects relay pairs", async () => {
  assert.equal(await onRelay({ send: { getStats: async () => stats("relay") } } as never), true);
  assert.equal(await onRelay({ send: { getStats: async () => stats("host") } } as never), false);
});

test("relay login refresh: wired — server call:turnRefresh for live-call participants only, engine starts/stops it", () => {
  const srv = readFileSync("server/calls/index.ts", "utf8");
  assert.match(srv, /socket\.on\("call:turnRefresh"/);
  assert.match(srv, /live\.id !== callId/);
  const e = readFileSync("src/lib/calls/engine.ts", "utf8");
  assert.ok(e.includes("this.turnRefresh.start(this.s.call.id)"));
  assert.ok(e.includes("this.turnRefresh.stop()"));
  assert.ok(!readFileSync("src/lib/calls/mediasoupSession.ts", "utf8").includes("turnRefresh"), "mediasoupSession.ts untouched");
});
