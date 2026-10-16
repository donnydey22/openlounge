import test from "node:test";
import assert from "node:assert/strict";
import { CallService } from "../../server/calls/service";
import type { CallMediaBackend } from "../../server/calls/mediaBackend";

const backend = (): CallMediaBackend => ({ provider: "mediasoup", issue: async ({ callId, userId }) => ({ provider: "mediasoup", url: "x", token: `${callId}-${userId}` }), close: () => {}, relay: async () => ({}) });
function svc(clock: { now: number }) {
  const peer = (id: string) => ({ id, name: id, color: "#000", photoUrl: null });
  return new CallService({ emitUser: () => {}, isConnected: () => true, isForeground: () => true, peer, policy: () => ({ ok: true }), inRoom: () => false, appendCallMessage: () => {}, selectMedia: backend, liveKitFallback: backend, now: () => clock.now });
}

test("detached: call page gone while the user stays online elsewhere → call ends after CALL_DETACHED_MS, new call possible", async () => {
  const clock = { now: 1_700_000_000_000 };
  const s = svc(clock);
  try {
    const st = await s.start("a", "b", false, "ca");
    assert.ok(st.ok); if (!st.ok) return;
    await s.accept(st.call.id, "b", "cb");
    s.connClosed("cb", "b"); // callee's call page closed; another socket keeps b "connected"
    s._sweep();
    clock.now += 30_000; s._sweep();
    assert.equal((s as any).calls.get(st.call.id).phase, "active", "still inside the grace");
    clock.now += 31_000; s._sweep();
    assert.equal((s as any).calls.get(st.call.id).phase, "ended");
    const again = await s.start("a", "b", false, "ca2");
    assert.ok(again.ok, "a stale call no longer blocks a new one");
  } finally { s.dispose?.(); }
});

test("detached: a reloaded page that rejoins (call:get) keeps the call", async () => {
  const clock = { now: 1_700_000_000_000 };
  const s = svc(clock);
  try {
    const st = await s.start("a", "b", false, "ca");
    assert.ok(st.ok); if (!st.ok) return;
    await s.accept(st.call.id, "b", "cb");
    s.connClosed("cb", "b");
    s._sweep();
    clock.now += 5_000;
    await s.get_(st.call.id, "b", "cb2");
    clock.now += 120_000; s._sweep();
    assert.equal((s as any).calls.get(st.call.id).phase, "active");
  } finally { s.dispose?.(); }
});
