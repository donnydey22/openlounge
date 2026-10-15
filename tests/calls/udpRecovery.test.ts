import test from "node:test";
import assert from "node:assert/strict";
import { UdpRecoveryPolicy } from "../../src/lib/calls/udpRecovery";
import { CallService } from "../../server/calls/service";
import type { CallMediaBackend } from "../../server/calls/mediaBackend";

const opts = { tcpStableMs: 20_000, baseBackoffMs: 15_000, maxBackoffMs: 120_000, udpHoldMs: 30_000, jitter: 0, random: () => 0.5 };

test("mid-call UDP drop: bridge on TCP, return to UDP only after TCP is stable and backoff elapsed", () => {
  const p = new UdpRecoveryPolicy(opts);
  let t = 0;
  t = 61_000; // UDP held past 60 s, then drops
  p.onUdpDrop(t);
  assert.equal(p.path, "tcp");
  assert.equal(p.shouldTryUdp(t), false);
  p.onTcpConnected(t + 1_000);
  assert.equal(p.shouldTryUdp(t + 16_000), false, "TCP not stable for 20 s yet (hysteresis)");
  p.onTcpUnstable(); // bridge itself blips: window restarts
  p.onTcpConnected(t + 18_000);
  assert.equal(p.shouldTryUdp(t + 37_000), false);
  assert.equal(p.shouldTryUdp(t + 38_000), true);
  p.onTrialStart(t + 38_000);
  assert.equal(p.path, "udp-trial");
  p.tick(t + 60_000);
  assert.equal(p.path, "udp-trial", "not promoted before udpHoldMs");
  p.tick(t + 68_000);
  assert.equal(p.path, "udp");
  assert.equal(p.failures, 0);
});

test("flapping UDP: each failed trial doubles the backoff up to the cap, and retries continue until hang-up", () => {
  const p = new UdpRecoveryPolicy(opts);
  let t = 100_000;
  p.onUdpDrop(t);
  const gaps: number[] = [];
  for (let i = 0; i < 6; i++) {
    p.onTcpConnected(t);
    let k = t;
    while (!p.shouldTryUdp(k)) k += 1_000;
    gaps.push(k - t);
    p.onTrialStart(k);
    t = k + 5_000; // UDP fails again 5 s into the trial
    p.onUdpDrop(t);
  }
  assert.deepEqual(gaps, [20_000, 30_000, 60_000, 120_000, 120_000, 120_000]);
  assert.equal(p.failures, 6);
  p.end();
  p.onTcpConnected(t);
  assert.equal(p.shouldTryUdp(t + 1e9), false, "no attempts after hang-up");
});

test("refused restore (server hysteresis) honours retryInMs", () => {
  const p = new UdpRecoveryPolicy(opts);
  p.onUdpDrop(0);
  p.onTcpConnected(0);
  assert.equal(p.shouldTryUdp(20_000), true);
  p.onTrialRefused(20_000, 200_000);
  assert.equal(p.shouldTryUdp(200_000), false);
  assert.equal(p.shouldTryUdp(220_000), true);
});

function backend(provider: "mediasoup" | "livekit", closed: string[]): CallMediaBackend {
  return {
    provider,
    issue: async ({ callId, userId }) => ({ provider, url: "x", token: `${provider}-${callId}-${userId}` }),
    close: (id) => closed.push(`${provider}:${id}`),
    relay: provider === "mediasoup" ? async () => ({}) : undefined,
  };
}

test("server: UDP drop → TCP fallback → restore back to UDP for both participants, rate-limited", async () => {
  let now = 1_700_000_000_000;
  const events: Array<{ u: string; ev: string; data: any }> = [];
  const closed: string[] = [];
  const peer = (id: string) => ({ id, name: id, color: "#000", photoUrl: null });
  const svc = new CallService({
    emitUser: (u, ev, data) => events.push({ u, ev, data }),
    isConnected: () => true, isForeground: () => true, peer, policy: () => ({ ok: true }), inRoom: () => false, appendCallMessage: () => {},
    selectMedia: () => backend("mediasoup", closed), liveKitFallback: () => backend("livekit", closed), now: () => now,
  });
  try {
    const s = await svc.start("a", "b", false);
    assert.ok(s.ok);
    if (!s.ok) return;
    const id = s.call.id;
    assert.equal((await svc.restoreMedia(id, "a")).ok, false, "not active yet");
    await svc.accept(id, "b");
    now += 61_000;
    const fb = await svc.fallbackMedia(id, "a");
    assert.ok(fb.ok && fb.media?.provider === "livekit");
    const early = await svc.restoreMedia(id, "a");
    assert.equal(early.ok, false, "server hysteresis");
    now += 20_000;
    const r = await svc.restoreMedia(id, "b");
    assert.ok(r.ok && r.media?.provider === "mediasoup");
    const restores = events.filter((e) => e.ev === "call:mediaRestore");
    assert.deepEqual(restores.map((e) => e.u).sort(), ["a", "b"]);
    assert.ok(restores.every((e) => e.data.media.provider === "mediasoup"));
    assert.ok(closed.includes(`livekit:${id}`));
    // can fall back again (unchanged path)
    now += 1_000;
    const fb2 = await svc.fallbackMedia(id, "a");
    assert.ok(fb2.ok && fb2.media?.provider === "livekit");
  } finally {
    svc.dispose?.();
  }
});
