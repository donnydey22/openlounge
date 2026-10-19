import test from "node:test";
import assert from "node:assert/strict";
import { CallService, CALL_CALLER_GONE_MS } from "../../server/calls/service";
import type { CallMediaBackend } from "../../server/calls/mediaBackend";

const backend = (): CallMediaBackend => ({ provider: "mediasoup", issue: async ({ callId, userId }) => ({ provider: "mediasoup", url: "x", token: `${callId}-${userId}` }), close: () => {}, relay: async () => ({}) });
function svc(clock: { now: number }, connected: Set<string> = new Set(["a", "b"])) {
  const peer = (id: string) => ({ id, name: id, color: "#000", photoUrl: null });
  const logs: string[] = [];
  const s = new CallService({ emitUser: () => {}, isConnected: (u) => connected.has(u), isForeground: () => true, peer, policy: () => ({ ok: true }), inRoom: () => false, appendCallMessage: () => {}, selectMedia: backend, liveKitFallback: backend, now: () => clock.now, log: (m) => void logs.push(m) });
  return { s, logs };
}
const phase = (s: CallService, id: string) => (s as any).calls.get(id).phase;

test("half-open ring: caller's call page closed while still online elsewhere → ring cancelled after CALL_CALLER_GONE_MS", async () => {
  const clock = { now: 1_700_000_000_000 };
  const { s, logs } = svc(clock);
  try {
    const st = await s.start("a", "b", false, "ca");
    assert.ok(st.ok); if (!st.ok) return;
    s.ack(st.call.id, "b");
    s.connClosed("ca", "a");
    s._sweep();
    clock.now += CALL_CALLER_GONE_MS - 1_000; s._sweep();
    assert.equal(phase(s, st.call.id), "ringing", "short blips (WebView reload) are tolerated");
    clock.now += 2_000; s._sweep();
    assert.equal(phase(s, st.call.id), "ended");
    assert.equal((s as any).calls.get(st.call.id).outcome, "cancelled");
    assert.ok(logs.includes("call caller detached"));
    assert.equal(s.isBusy("b"), false, "callee is free again");
  } finally { s.dispose(); }
});

test("half-open ring: a reloaded caller page that re-binds (call:get) keeps ringing", async () => {
  const clock = { now: 1_700_000_000_000 };
  const { s } = svc(clock);
  try {
    const st = await s.start("a", "b", false, "ca");
    assert.ok(st.ok); if (!st.ok) return;
    s.connClosed("ca", "a");
    s._sweep();
    clock.now += 2_000;
    await s.get_(st.call.id, "a", "ca2");
    clock.now += CALL_CALLER_GONE_MS + 5_000; s._sweep();
    assert.notEqual(phase(s, st.call.id), "ended");
  } finally { s.dispose(); }
});

test("half-open ring: calls started without a connection id (legacy path) are unaffected", async () => {
  const clock = { now: 1_700_000_000_000 };
  const { s } = svc(clock);
  try {
    const st = await s.start("a", "b", false);
    assert.ok(st.ok); if (!st.ok) return;
    clock.now += CALL_CALLER_GONE_MS + 5_000; s._sweep();
    assert.notEqual(phase(s, st.call.id), "ended");
  } finally { s.dispose(); }
});

test("half-open ring: caller with no socket at all still cancels (existing behaviour)", async () => {
  const clock = { now: 1_700_000_000_000 };
  const connected = new Set(["b"]);
  const { s } = svc(clock, connected);
  try {
    const st = await s.start("a", "b", false, "ca");
    assert.ok(st.ok); if (!st.ok) return;
    s._sweep();
    clock.now += CALL_CALLER_GONE_MS + 1_000; s._sweep();
    assert.equal(phase(s, st.call.id), "ended");
  } finally { s.dispose(); }
});

test("media leave: idempotent for an ended or unknown call, not for a live one or a stranger", async () => {
  const clock = { now: 1_700_000_000_000 };
  const { s } = svc(clock);
  try {
    const st = await s.start("a", "b", false, "ca");
    assert.ok(st.ok); if (!st.ok) return;
    assert.equal(s.leaveIsNoop(st.call.id, "a"), false, "live call: real leave");
    s.hangup(st.call.id, "a");
    assert.equal(s.leaveIsNoop(st.call.id, "a"), true);
    assert.equal(s.leaveIsNoop(st.call.id, "z"), false, "not a participant");
    assert.equal(s.leaveIsNoop("nope", "a"), true, "unknown (e.g. after a server restart)");
    assert.equal(s.leaveIsNoop(42, "a"), false);
  } finally { s.dispose(); }
});
