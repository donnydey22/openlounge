import test from "node:test";
import assert from "node:assert/strict";
import { CallService } from "../../server/calls/service";
import type { CallMediaBackend } from "../../server/calls/mediaBackend";

const now = 1_700_000_000_000;
const peer = (id: string) => ({ id, name: id === "a" ? "Ana" : "Ben", color: "#123456", photoUrl: null });

function backend(provider: "mediasoup" | "livekit", state: { closed: string[]; relays: string[] }): CallMediaBackend {
  return {
    provider,
    issue: async ({ callId, userId }) => ({ provider, url: provider === "livekit" ? "wss://livekit.example" : "broker", token: `${provider}-${callId}-${userId}`, ...(provider === "mediasoup" ? { callId } : {}) }),
    close: (callId) => state.closed.push(`${provider}:${callId}`),
    relay: provider === "mediasoup" ? async ({ method }) => {
      state.relays.push(method);
      return { method };
    } : undefined,
  };
}

function setup() {
  const events: Array<{ userId: string; ev: string; data: any }> = []; // test-only assertion capture
  const state = { closed: [] as string[], relays: [] as string[] };
  const udp = backend("mediasoup", state);
  const tcp = backend("livekit", state);
  const service = new CallService({
    emitUser: (userId, ev, data) => events.push({ userId, ev, data }),
    isConnected: () => true,
    isForeground: () => true,
    peer,
    policy: () => ({ ok: true }),
    inRoom: () => false,
    appendCallMessage: () => {},
    selectMedia: () => udp,
    liveKitFallback: () => tcp,
    now: () => now,
  });
  return { service, events, state };
}

test("layered selection starts on brokered UDP and atomically moves both participants to existing LiveKit", async () => {
  const { service, events, state } = setup();
  try {
    const start = await service.start("a", "b", false);
    assert.equal(start.ok, true);
    if (!start.ok) return;
    assert.equal(start.media?.provider, "mediasoup");
    assert.ok(start.media?.token.startsWith("mediasoup-"));

    const relay = await service.mediaRequest(start.call.id, "a", "conn-a", "join", {});
    assert.deepEqual(relay, { ok: true, result: { method: "join" } });

    const fallback = await service.fallbackMedia(start.call.id, "a");
    assert.equal(fallback.ok, true);
    if (!fallback.ok) return;
    assert.equal(fallback.media?.provider, "livekit");
    assert.deepEqual(state.closed, [`mediasoup:${start.call.id}`]);
    const switches = events.filter((e) => e.ev === "call:mediaFallback");
    assert.equal(switches.length, 2);
    assert.deepEqual(switches.map((e) => e.data.media.provider).sort(), ["livekit", "livekit"]);

    const current = await service.get_(start.call.id, "b");
    assert.equal(current.ok, true);
    if (current.ok) assert.equal(current.media?.provider, "livekit");
    assert.deepEqual(await service.mediaRequest(start.call.id, "a", "conn-a", "join", {}), { ok: false, error: "UDP media isn't available" });

    const again = await service.fallbackMedia(start.call.id, "b");
    assert.equal(again.ok, true);
    if (again.ok) assert.equal(again.alreadyFallback, true);
  } finally {
    service.dispose();
  }
});

test("layered fallback fails closed when the durable LiveKit path is unavailable", async () => {
  const { service } = setup();
  try {
    const start = await service.start("a", "b", false);
    assert.equal(start.ok, true);
    if (!start.ok) return;
    (service as any).d.liveKitFallback = () => null; // test boundary: remove only the fallback dependency
    const fallback = await service.fallbackMedia(start.call.id, "a");
    assert.deepEqual(fallback, { ok: false, error: "TCP fallback isn't available" });
    const current = await service.get_(start.call.id, "a");
    assert.equal(current.ok, true);
    if (current.ok) assert.equal(current.media?.provider, "mediasoup");
  } finally {
    service.dispose();
  }
});

test("only an active server-issued iPhone native-video call enables the shared transport bootstrap", async () => {
  const { service } = setup();
  try {
    const plain = await service.start("a", "b", true);
    assert.equal(plain.ok, true);
    if (!plain.ok) return;
    assert.equal(service.nativeVideoQualityBootstrap(plain.call.id, false), false);
    assert.equal(service.nativeVideoQualityBootstrap(plain.call.id, true), false);
    service.hangup(plain.call.id, "a");

    const native = await service.start("a", "b", true, undefined, true);
    assert.equal(native.ok, true);
    if (!native.ok) return;
    assert.equal(service.nativeVideoQualityBootstrap(native.call.id, false), false, "browser transport cannot receive the bootstrap");
    assert.equal(service.nativeVideoQualityBootstrap(native.call.id, true), true);
    service.hangup(native.call.id, "a");
    assert.equal(service.nativeVideoQualityBootstrap(native.call.id, true), false);
  } finally {
    service.dispose();
  }
});

test("called parties cannot obtain or relay direct media before explicitly accepting", async () => {
  const { service, events } = setup();
  try {
    const start = await service.start("a", "b", false);
    assert.equal(start.ok, true);
    if (!start.ok) return;
    assert.equal(start.media?.provider, "mediasoup");
    const incoming = events.find((event) => event.userId === "b" && event.ev === "call:incoming");
    assert.equal(incoming?.data.media, null);

    const beforeAccept = await service.get_(start.call.id, "b");
    assert.equal(beforeAccept.ok, true);
    if (beforeAccept.ok) assert.equal(beforeAccept.media, null);
    assert.deepEqual(await service.mediaRequest(start.call.id, "b", "conn-b", "join", {}), { ok: false, error: "Answer the call before joining direct media" });

    const accepted = await service.accept(start.call.id, "b");
    assert.equal(accepted.ok, true);
    if (accepted.ok) assert.equal(accepted.media?.provider, "mediasoup");
    assert.deepEqual(await service.mediaRequest(start.call.id, "b", "conn-b", "join", {}), { ok: true, result: { method: "join" } });
  } finally {
    service.dispose();
  }
});
