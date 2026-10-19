import test from "node:test";
import assert from "node:assert/strict";
import { CallService, CALL_DETACHED_MS } from "../../server/calls/service";
import type { CallMediaBackend } from "../../server/calls/mediaBackend";

const backend = (): CallMediaBackend => ({ provider: "mediasoup", issue: async ({ callId, userId }) => ({ provider: "mediasoup", url: "x", token: `${callId}-${userId}` }), close: () => {}, relay: async () => ({}) });
function svc(clock: { now: number }) {
  const peer = (id: string) => ({ id, name: id, color: "#000", photoUrl: null });
  const sent: { to: string; ev: string; d: any }[] = [];
  const s = new CallService({ emitUser: (to, ev, d) => void sent.push({ to, ev, d }), isConnected: () => true, isForeground: () => true, peer, policy: () => ({ ok: true }), inRoom: () => false, appendCallMessage: () => {}, selectMedia: backend, liveKitFallback: backend, now: () => clock.now });
  return { s, peerEvents: () => sent.filter((e) => e.ev === "call:peer") };
}

test("reconnect: detached peer → other side told offline (detached) once, then online when the page re-joins", async () => {
  const clock = { now: 1_700_000_000_000 };
  const { s, peerEvents } = svc(clock);
  try {
    const st = await s.start("a", "b", false, "ca");
    assert.ok(st.ok); if (!st.ok) return;
    await s.accept(st.call.id, "b", "cb");
    s.connClosed("cb", "b");
    s._sweep();
    assert.equal(peerEvents().length, 0, "no notice on first detection (reload in flight)");
    clock.now += 5_000; s._sweep();
    clock.now += 5_000; s._sweep();
    const off = peerEvents();
    assert.equal(off.length, 1, "exactly one notice");
    assert.deepEqual({ to: off[0].to, online: off[0].d.online, detached: off[0].d.detached, graceMs: off[0].d.graceMs }, { to: "a", online: false, detached: true, graceMs: CALL_DETACHED_MS });
    await s.get_(st.call.id, "b", "cb2");
    s._sweep();
    const on = peerEvents();
    assert.equal(on.length, 2);
    assert.deepEqual({ to: on[1].to, online: on[1].d.online }, { to: "a", online: true });
    assert.equal((s as any).calls.get(st.call.id).phase, "active");
  } finally { s.dispose(); }
});

test("reconnect: a quick re-join (< notice window) sends nothing", async () => {
  const clock = { now: 1_700_000_000_000 };
  const { s, peerEvents } = svc(clock);
  try {
    const st = await s.start("a", "b", false, "ca");
    assert.ok(st.ok); if (!st.ok) return;
    await s.accept(st.call.id, "b", "cb");
    s.connClosed("cb", "b");
    s._sweep();
    clock.now += 2_000;
    await s.get_(st.call.id, "b", "cb2");
    clock.now += 5_000; s._sweep();
    assert.equal(peerEvents().length, 0);
  } finally { s.dispose(); }
});

test("reconnect: detached past CALL_DETACHED_MS still ends the call (unchanged)", async () => {
  const clock = { now: 1_700_000_000_000 };
  const { s } = svc(clock);
  try {
    const st = await s.start("a", "b", false, "ca");
    assert.ok(st.ok); if (!st.ok) return;
    await s.accept(st.call.id, "b", "cb");
    s.connClosed("cb", "b");
    for (let t = 0; t <= CALL_DETACHED_MS + 10_000; t += 5_000) { s._sweep(); clock.now += 5_000; }
    assert.equal((s as any).calls.get(st.call.id).phase, "ended");
  } finally { s.dispose(); }
});
