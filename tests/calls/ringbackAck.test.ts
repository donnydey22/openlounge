// Oct 15 2026: iPhone caller heard no ringback (element "playing" but silent after mic / CallKit session swap) and the
// callee's foreground socket never acked, so nothing rang for 45 s. Covers the stall re-arm and the ack→push fallback.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CallService, CALL_ACK_FALLBACK_MS } from "../../server/calls/service";
import type { CallMediaBackend } from "../../server/calls/mediaBackend";

function backend(provider: "mediasoup" | "livekit"): CallMediaBackend {
  return {
    provider,
    issue: async ({ callId, userId }) => ({ provider, url: "x", token: `${provider}-${callId}-${userId}` }),
    close: () => {},
    relay: provider === "mediasoup" ? async () => ({}) : undefined,
  };
}

function svc(acks: boolean, foreground = true) {
  const pushes: string[] = [];
  const logs: string[] = [];
  const peer = (id: string) => ({ id, name: id, color: "#000", photoUrl: null });
  const s = new CallService({
    emitUser: () => {},
    isConnected: () => true, isForeground: () => foreground, peer, policy: () => ({ ok: true }), inRoom: () => false, appendCallMessage: () => {},
    selectMedia: () => backend("mediasoup"), liveKitFallback: () => backend("livekit"), now: () => Date.now(),
    push: { incoming: (u: string) => pushes.push(u), cancel: () => {} },
    log: (m: string) => logs.push(m),
  } as never);
  return { s, pushes, logs, acks };
}

test("foreground callee that never acks gets a push after CALL_ACK_FALLBACK_MS", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { s, pushes, logs } = svc(false);
  const r = await s.start("a", "b", false);
  assert.ok(r.ok);
  assert.deepEqual(pushes, []);
  t.mock.timers.tick(CALL_ACK_FALLBACK_MS + 1);
  assert.deepEqual(pushes, ["b"]);
  assert.ok(logs.includes("call ack fallback push"));
});

test("an acked call never gets the fallback push", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { s, pushes } = svc(true);
  const r = await s.start("a", "b", false);
  assert.ok(r.ok && r.call);
  s.ack(r.call!.id, "b");
  t.mock.timers.tick(CALL_ACK_FALLBACK_MS + 1);
  assert.deepEqual(pushes, []);
});

test("background callee is pushed once (no duplicate from the fallback)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { s, pushes } = svc(false, false);
  await s.start("a", "b", false);
  t.mock.timers.tick(CALL_ACK_FALLBACK_MS + 1);
  assert.deepEqual(pushes, ["b"]);
});

test("ring element: stalled-but-playing is restarted, Web Audio revived, re-arm probes instead of blind restart", () => {
  const src = readFileSync("src/lib/calls/tones.ts", "utf8");
  assert.match(src, /const stalled = !e\.paused && lastPos !== null/);
  assert.match(src, /if \(e\.paused \|\| stalled \|\| force\)/);
  assert.match(src, /if \(stalls >= 2\) reviveWebAudio\(\)/);
  assert.match(src, /linearRampToValueAtTime\(1, c\.currentTime \+ 0\.01\)/);
  assert.match(src, /setTimeout\(\(\) => \{[\s\S]{0,160}fallback\(true\)[\s\S]{0,20}RING_PROBE_MS\)/);
});

test("outgoing call re-arms the ringback once the mic request settles", () => {
  const src = readFileSync("src/lib/calls/engine.ts", "utf8");
  assert.match(src, /this\.preMic = this\.acquireMic\(\);\s*\n\s*\/\/[^\n]*\n\s*void this\.preMic\.then\([^\n]*rearmRing\(\)/);
});
