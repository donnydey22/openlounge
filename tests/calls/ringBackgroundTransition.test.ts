import test from "node:test";
import assert from "node:assert/strict";
import { CallService, CALL_BG_RING_PUSH_MS } from "../../server/calls/service";
import type { CallMediaBackend } from "../../server/calls/mediaBackend";

const backend = (): CallMediaBackend => ({ provider: "livekit", issue: async ({ callId, userId }) => ({ provider: "livekit", url: "x", token: `${callId}-${userId}` }), close: () => {} });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function svc(fg: Map<string, boolean>) {
  const peer = (id: string) => ({ id, name: id, color: "#000", photoUrl: null });
  const pushes: string[] = [];
  const s = new CallService({
    emitUser: () => {}, isConnected: () => true, isForeground: (u) => fg.get(u) ?? true, peer, policy: () => ({ ok: true }), inRoom: () => false, appendCallMessage: () => {}, selectMedia: backend,
    push: { incoming: () => void pushes.push("incoming"), repush: () => void pushes.push("repush"), cancel: (_c, _id, r) => void pushes.push(`cancel:${r}`) },
  });
  return { s, pushes };
}

test("ring → callee backgrounds the app → one non-VoIP push after the debounce; answer cancels it", async () => {
  const fg = new Map([["b", true]]);
  const { s, pushes } = svc(fg);
  try {
    const st = await s.start("a", "b", false, "ca");
    assert.ok(st.ok); if (!st.ok) return;
    s.ack(st.call.id, "b");
    fg.set("b", false);
    s.visibilityChanged("b");
    s.visibilityChanged("b"); // repeated hide events don't double-push
    await wait(CALL_BG_RING_PUSH_MS + 200);
    assert.deepEqual(pushes, ["repush"], "never a second VoIP/CallKit push");
    await s.accept(st.call.id, "b", "cb");
    assert.deepEqual(pushes, ["repush", "cancel:answered"]);
  } finally { s.dispose(); }
});

test("quick app switch (back in foreground within the debounce) → no push", async () => {
  const fg = new Map([["b", true]]);
  const { s, pushes } = svc(fg);
  try {
    const st = await s.start("a", "b", false, "ca");
    assert.ok(st.ok); if (!st.ok) return;
    fg.set("b", false); s.visibilityChanged("b");
    await wait(200); fg.set("b", true);
    await wait(CALL_BG_RING_PUSH_MS + 200);
    assert.deepEqual(pushes, []);
  } finally { s.dispose(); }
});

test("no push for: the caller backgrounding, an active call, a call already pushed", async () => {
  const fg = new Map([["a", true], ["b", true]]);
  const { s, pushes } = svc(fg);
  try {
    const st = await s.start("a", "b", false, "ca");
    assert.ok(st.ok); if (!st.ok) return;
    fg.set("a", false); s.visibilityChanged("a");
    await s.accept(st.call.id, "b", "cb");
    fg.set("b", false); s.visibilityChanged("b");
    await wait(CALL_BG_RING_PUSH_MS + 200);
    assert.deepEqual(pushes, []);
    s.hangup(st.call.id, "a");
    // callee already backgrounded at ring time → pushed at start; hiding again adds nothing
    fg.set("b", false); fg.set("a", true);
    const st2 = await s.start("a", "b", false, "ca2");
    assert.ok(st2.ok);
    s.visibilityChanged("b");
    await wait(CALL_BG_RING_PUSH_MS + 200);
    assert.deepEqual(pushes, ["incoming"]);
  } finally { s.dispose(); }
});

test("call ends during the debounce → no push", async () => {
  const fg = new Map([["b", true]]);
  const { s, pushes } = svc(fg);
  try {
    const st = await s.start("a", "b", false, "ca");
    assert.ok(st.ok); if (!st.ok) return;
    fg.set("b", false); s.visibilityChanged("b");
    s.hangup(st.call.id, "a");
    await wait(CALL_BG_RING_PUSH_MS + 200);
    assert.deepEqual(pushes, []);
  } finally { s.dispose(); }
});
