// Oct 17 hardening from Keiko/Waqas call logs: stale busy self-heal (faf1a89a), one ring retry for un-acked pushed
// calls (51c135b3 / 51976b82), and the ended-call view used to re-send "ended" to a client still stuck on it (d8d7eded).
process.env.CALL_REPUSH_MS = "60";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CallService } from "../../server/calls/service";
import type { CallMediaBackend } from "../../server/calls/mediaBackend";

const backend = (): CallMediaBackend => ({ provider: "mediasoup", issue: async ({ callId, userId }) => ({ provider: "mediasoup", url: "x", token: `${callId}-${userId}` }), close: () => {}, relay: async () => ({}) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function svc(clock: { now: number }, o: { foreground?: boolean; pushes?: string[]; logs?: string[]; inRoom?: boolean } = {}) {
  const peer = (id: string) => ({ id, name: id, color: "#000", photoUrl: null });
  return new CallService({
    emitUser: () => {}, isConnected: () => true, isForeground: () => o.foreground ?? true, peer, policy: () => ({ ok: true }), inRoom: () => !!o.inRoom,
    appendCallMessage: () => {}, selectMedia: backend, liveKitFallback: backend, now: () => clock.now,
    push: { incoming: (u, c) => o.pushes?.push(`in:${u}:${c.id}`), repush: (u, c) => o.pushes?.push(`re:${u}:${c.id}`), cancel: () => {} },
    log: (m) => o.logs?.push(m),
  });
}

test("busy: a live-map entry for an ended or missing call never makes the next dial busy", async () => {
  const clock = { now: 1_700_000_000_000 }, logs: string[] = [];
  const s = svc(clock, { logs });
  try {
    const a = await s.start("a", "b", false, "ca"); assert.ok(a.ok); if (!a.ok) return;
    await s.hangup(a.call.id, "a");
    (s as any).live.set("b", a.call.id); // leftover pointing at the ended call
    (s as any).live.set("c", "gone-call"); // leftover pointing at nothing
    const r1 = await s.start("a", "b", false, "ca2"); assert.ok(r1.ok, JSON.stringify(r1)); if (r1.ok) await s.hangup(r1.call.id, "a");
    const r2 = await s.start("a", "c", false, "ca3"); assert.ok(r2.ok, JSON.stringify(r2));
    assert.ok(logs.includes("call stale busy cleared"));
  } finally { s.dispose(); }
});

test("busy: a ringing call past its ring timeout (lost timer) is finished as missed; a real live call stays busy and is logged", async () => {
  const clock = { now: 1_700_000_000_000 }, logs: string[] = [];
  const s = svc(clock, { logs });
  try {
    const a = await s.start("a", "b", false, "ca"); assert.ok(a.ok); if (!a.ok) return;
    const busy = await s.start("x", "b", false, "cx"); assert.equal(busy.ok, false); assert.equal((busy as any).reason, "busy");
    assert.ok(logs.includes("call busy"));
    const rec = (s as any).calls.get(a.call.id); clearTimeout(rec.timer); rec.timer = null; // simulate a lost ring timer
    clock.now += 51_000;
    const ok = await s.start("x", "b", false, "cx2"); assert.ok(ok.ok, JSON.stringify(ok));
    assert.equal(rec.phase, "ended"); assert.equal(rec.outcome, "missed");
  } finally { s.dispose(); }
});

test("busy: an active call is never cleared by the stale check, however long", async () => {
  const clock = { now: 1_700_000_000_000 };
  const s = svc(clock);
  try {
    const a = await s.start("a", "b", false, "ca"); assert.ok(a.ok); if (!a.ok) return;
    await s.accept(a.call.id, "b", "cb");
    clock.now += 600_000;
    const r = await s.start("x", "b", false, "cx"); assert.equal((r as any).reason, "busy");
    assert.equal((s as any).calls.get(a.call.id).phase, "active");
  } finally { s.dispose(); }
});

test("ring retry: a pushed call nobody acked is pushed once more; an acked call is not", async () => {
  const clock = { now: 1_700_000_000_000 }, pushes: string[] = [];
  const s = svc(clock, { foreground: false, pushes });
  try {
    const a = await s.start("a", "b", false, "ca"); assert.ok(a.ok); if (!a.ok) return;
    await sleep(120);
    assert.deepEqual(pushes, [`in:b:${a.call.id}`, `re:b:${a.call.id}`]);
    await s.hangup(a.call.id, "a");
    pushes.length = 0;
    const c = await s.start("a", "c", false, "ca2"); assert.ok(c.ok); if (!c.ok) return;
    s.ack(c.call.id, "c");
    await sleep(120);
    assert.deepEqual(pushes, [`in:c:${c.call.id}`], "ring ack cancels the retry");
    await s.hangup(c.call.id, "a");
    pushes.length = 0;
    const d = await s.start("a", "d", false, "ca3"); assert.ok(d.ok); if (!d.ok) return;
    await s.hangup(d.call.id, "a");
    await sleep(120);
    assert.deepEqual(pushes, [`in:d:${d.call.id}`], "a cancelled call is not re-pushed");
  } finally { s.dispose(); }
});

test("ended view: only participants of an ENDED call get it (drives the call:diag re-send)", async () => {
  const clock = { now: 1_700_000_000_000 };
  const s = svc(clock);
  try {
    const a = await s.start("a", "b", false, "ca"); assert.ok(a.ok); if (!a.ok) return;
    assert.equal(s.endedFor(a.call.id, "b"), null, "live call");
    await s.hangup(a.call.id, "a");
    assert.equal(s.endedFor(a.call.id, "b")?.phase, "ended");
    assert.equal(s.endedFor(a.call.id, "z"), null, "not a participant");
    assert.equal(s.endedFor("nope", "b"), null);
  } finally { s.dispose(); }
});

test("wiring: call:diag re-sends ended state once per socket; repush never sends a VoIP push", () => {
  const src = readFileSync(new URL("../../server/calls/index.ts", import.meta.url), "utf8");
  assert.match(src, /endedFor\(d\?\.callId, uid\)/);
  assert.match(src, /endedResent\.has\(ended\.id\)/);
  const rp = src.slice(src.indexOf("repush:"), src.indexOf("cancel: (calleeId"));
  assert.ok(!/voipService|ring\(/.test(rp), "no VoIP push in repush");
});
