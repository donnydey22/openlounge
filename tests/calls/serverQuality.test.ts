import test from "node:test";
import assert from "node:assert/strict";
import { CallService } from "../../server/calls/service";
import type { CallMediaBackend } from "../../server/calls/mediaBackend";

const backend = (): CallMediaBackend => ({ provider: "livekit", issue: async ({ callId, userId }) => ({ provider: "livekit", url: "x", token: `${callId}-${userId}` }), close: () => {} });
function svc(clock: { now: number }) {
  const peer = (id: string) => ({ id, name: id, color: "#000", photoUrl: null });
  const logs: { m: string; x?: any }[] = [];
  const s = new CallService({ emitUser: () => {}, isConnected: () => true, isForeground: () => true, peer, policy: () => ({ ok: true }), inRoom: () => false, appendCallMessage: () => {}, selectMedia: backend, now: () => clock.now, log: (m, x) => void logs.push({ m, x }) });
  return { s, quality: () => logs.filter((l) => l.m === "call quality").map((l) => l.x) };
}
async function call(s: CallService) {
  const st = await s.start("a", "b", false, "ca");
  assert.ok(st.ok); if (!st.ok) throw new Error();
  await s.accept(st.call.id, "b", "cb");
  return st.call.id;
}

test("quality: both sides receive audio → two-way, summary logged, counter bumped", async () => {
  const clock = { now: 1_700_000_000_000 };
  const { s, quality } = svc(clock);
  try {
    const id = await call(s);
    for (let i = 0; i < 6; i++) {
      assert.ok(s.qualitySample(id, "a", { inKbps: 28, outKbps: 30, concealPct: 0.5 }));
      assert.ok(s.qualitySample(id, "b", { inKbps: 31, outKbps: 27, concealPct: "" }));
    }
    clock.now += 30_000;
    s.hangup(id, "a");
    const q = quality();
    assert.equal(q.length, 1);
    assert.equal(q[0].verdict, "two-way");
    assert.equal(q[0].caller.inKbpsMedian, 28);
    assert.equal(q[0].callee.concealPctMedian, null);
    assert.equal(s.stats().quality["two-way"], 1);
  } finally { s.dispose(); }
});

test("quality: one side hears nothing → one-way; nobody hears → no-audio", async () => {
  const clock = { now: 1_700_000_000_000 };
  const { s, quality } = svc(clock);
  try {
    let id = await call(s);
    for (let i = 0; i < 4; i++) { s.qualitySample(id, "a", { inKbps: 25, outKbps: 0.3 }); s.qualitySample(id, "b", { inKbps: 0.4, outKbps: 26 }); }
    clock.now += 20_000; s.hangup(id, "b");
    id = await call(s);
    for (let i = 0; i < 4; i++) { s.qualitySample(id, "a", { inKbps: 0 }); s.qualitySample(id, "b", { inKbps: 1 }); }
    clock.now += 20_000; s.hangup(id, "a");
    assert.deepEqual(quality().map((q) => q.verdict), ["one-way", "no-audio"]);
    assert.equal(quality()[0].callee.silentInPct, 100);
    assert.deepEqual(s.stats().quality, { "two-way": 0, "one-way": 1, "no-audio": 1, "no-data": 0 });
  } finally { s.dispose(); }
});

test("quality: no reports → no-data for a real call, nothing for a <10 s call or an unanswered one", async () => {
  const clock = { now: 1_700_000_000_000 };
  const { s, quality } = svc(clock);
  try {
    let id = await call(s);
    clock.now += 4_000; s.hangup(id, "a");
    id = await call(s);
    clock.now += 60_000; s.hangup(id, "a");
    const st = await s.start("a", "b", false, "ca"); assert.ok(st.ok); if (!st.ok) return;
    s.hangup(st.call.id, "a");
    assert.deepEqual(quality().map((q) => q.verdict), ["no-data"]);
  } finally { s.dispose(); }
});

test("quality: samples rejected for strangers, ringing/ended calls and junk values", async () => {
  const clock = { now: 1_700_000_000_000 };
  const { s } = svc(clock);
  try {
    const st = await s.start("a", "b", false, "ca"); assert.ok(st.ok); if (!st.ok) return;
    assert.equal(s.qualitySample(st.call.id, "a", { inKbps: 20 }), false, "not active yet");
    await s.accept(st.call.id, "b", "cb");
    assert.equal(s.qualitySample(st.call.id, "z", { inKbps: 20 }), false);
    assert.equal(s.qualitySample(st.call.id, "a", { inKbps: "abc", outKbps: -1 }), false);
    assert.equal(s.qualitySample("nope", "a", { inKbps: 20 }), false);
    s.hangup(st.call.id, "a");
    assert.equal(s.qualitySample(st.call.id, "a", { inKbps: 20 }), false);
  } finally { s.dispose(); }
});

test("quality: only one side reported → its own direction decides", () => {
  const hears = { samples: 3, inKbpsMedian: 20, outKbpsMedian: 20, concealPctMedian: null, silentInPct: 0, hears: true };
  assert.equal(CallService.qualityOf(hears, null), "two-way");
  assert.equal(CallService.qualityOf(null, { ...hears, hears: false }), "one-way");
  assert.equal(CallService.qualityOf(null, null), "no-data");
});
