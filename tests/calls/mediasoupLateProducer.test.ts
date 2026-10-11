import test from "node:test";
import assert from "node:assert/strict";
import { MediasoupCallSession } from "../../src/lib/calls/mediasoupSession";

// A peer's video producer created while this side's consume pass for its audio is still in flight must not be dropped.
test("late producer notice during an in-flight sync triggers another pass (video consumed + resumed)", async () => {
  const handlers = new Map<string, () => void>();
  const pending = [
    [{ id: "c-audio", producerId: "p-a", kind: "audio", rtpParameters: {} }],
    [{ id: "c-video", producerId: "p-v", kind: "video", rtpParameters: {} }],
  ];
  const resumed: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let consumeCalls = 0;
  const socket = {
    on: (ev: string, fn: () => void) => handlers.set(ev, fn),
    off: () => {},
    request: async (ev: string, data: any) => {
      if (ev === "ms:consume") {
        consumeCalls++;
        if (consumeCalls === 1) await gate; // first pass is slow
        return { ok: true, consumers: pending.shift() ?? [] };
      }
      if (ev === "ms:consumer:resume") resumed.push(data.consumerId);
      return { ok: true };
    },
  };
  const tracks: string[] = [];
  const s = new MediasoupCallSession(socket as any, { provider: "mediasoup", url: "broker", token: "t", callId: "call1" } as any, {
    onRemoteTrack: (t) => tracks.push(t.kind),
    onState: () => {},
    onLocalVideo: () => {},
  });
  const anyS = s as any;
  anyS.device = { rtpCapabilities: {} };
  anyS.recv = { id: "recv1", consume: async (p: any) => ({ id: p.id, kind: p.kind, track: {}, close() {} }) };
  const first = anyS.syncConsumers();
  anyS.onAvailable(); // video producer notice arrives mid-pass
  release();
  await first;
  assert.deepEqual(tracks, ["audio", "video"]);
  assert.deepEqual(resumed, ["c-audio", "c-video"]);
  assert.equal(consumeCalls, 2);
});

test("connect-time sync awaits a pass already running from an earlier notice", async () => {
  let consumeCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const socket = { on() {}, off() {}, request: async (ev: string) => {
    if (ev === "ms:consume") { consumeCalls++; if (consumeCalls === 1) await gate; return { ok: true, consumers: consumeCalls === 2 ? [{ id: "c1", producerId: "p1", kind: "video", rtpParameters: {} }] : [] }; }
    return { ok: true };
  } };
  const got: string[] = [];
  const s = new MediasoupCallSession(socket as any, { provider: "mediasoup", callId: "c" } as any, { onRemoteTrack: (t) => got.push(t.kind), onState() {}, onLocalVideo() {} });
  const a = s as any;
  a.device = { rtpCapabilities: {} };
  a.recv = { id: "r", consume: async (p: any) => ({ id: p.id, kind: p.kind, track: {}, close() {} }) };
  void a.syncConsumers();
  const awaited = a.syncConsumers(); // connectInner's final sync
  release();
  await awaited;
  assert.deepEqual(got, ["video"]);
});
