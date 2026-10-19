import test from "node:test";
import assert from "node:assert/strict";
import { IosMicWatch, iosMicReacquireEligible, micSampleSilent, type IosMicGateInput } from "../../src/lib/calls/iosMicReacquire";
import { iosMicReacquireEnabled } from "../../server/calls/sfuSelect";
import { CallService } from "../../server/calls/service";
import type { CallMediaBackend } from "../../server/calls/mediaBackend";

const OK: IosMicGateInput = { flag: true, localPlatform: "ios", role: "caller", video: true, nativeMedia: false, peerPlatform: "android", provider: "mediasoup" };

test("gate: fires for iOS wrapper caller, video, WebView media, Android callee, flag on", () => {
  assert.equal(iosMicReacquireEligible(OK), true);
});
const excluded: [string, Partial<IosMicGateInput>][] = [
  ["flag off (default)", { flag: false }],
  ["iPhone is the callee", { role: "callee" }],
  ["no role", { role: null }],
  ["iPhone → iPhone", { peerPlatform: "ios" }],
  ["iPhone → web", { peerPlatform: "web" }],
  ["peer platform unknown", { peerPlatform: undefined }],
  ["peer platform null", { peerPlatform: null }],
  ["voice call", { video: false }],
  ["native media on", { nativeMedia: true }],
  ["Android local", { localPlatform: "android" }],
  ["plain web local", { localPlatform: "web" }],
  ["web (null platform)", { localPlatform: null }],
  ["LiveKit path", { provider: "livekit" }],
  ["Android caller → Android", { localPlatform: "android", peerPlatform: "android" }],
  ["Android → iPhone (iPhone callee)", { localPlatform: "ios", role: "callee", peerPlatform: "android" }],
];
for (const [name, patch] of excluded)
  test(`gate: never fires — ${name}`, () => assert.equal(iosMicReacquireEligible({ ...OK, ...patch }), false));

test("server switch: CALL_IOS_MIC_REACQUIRE defaults OFF, only exact 'on' enables", () => {
  assert.equal(iosMicReacquireEnabled({}), false);
  assert.equal(iosMicReacquireEnabled({ CALL_IOS_MIC_REACQUIRE: "1" }), false);
  assert.equal(iosMicReacquireEnabled({ CALL_IOS_MIC_REACQUIRE: "true" }), false);
  assert.equal(iosMicReacquireEnabled({ CALL_IOS_MIC_REACQUIRE: "on" }), true);
});

test("silence: dead sender only (no level AND ~0 kbps); quiet speaker still sending is not silent", () => {
  assert.equal(micSampleSilent({ level: 0, outKbps: 0 }), true);
  assert.equal(micSampleSilent({ level: null, outKbps: 0.2 }), true);
  assert.equal(micSampleSilent({ level: 0, outKbps: 18 }), false);
  assert.equal(micSampleSilent({ level: 0.2, outKbps: 0 }), false);
  assert.equal(micSampleSilent({ level: 0, outKbps: null }), false);
});

test("server: accept records callee platform on the call; garbage ignored", async () => {
  const backend = (): CallMediaBackend => ({ provider: "livekit", issue: async ({ callId, userId }) => ({ provider: "livekit", url: "x", token: `${callId}-${userId}` }), close: () => {} });
  const peer = (id: string) => ({ id, name: id, color: "#000", photoUrl: null });
  const s = new CallService({ emitUser: () => {}, isConnected: () => true, isForeground: () => true, peer, policy: () => ({ ok: true }), inRoom: () => false, appendCallMessage: () => {}, selectMedia: backend, now: () => Date.now(), log: () => {} });
  const st = await s.start("a", "b", true, "ca");
  assert.ok(st.ok); if (!st.ok) throw new Error();
  const r = await s.accept(st.call.id, "b", "cb", "android");
  assert.ok(r.ok); if (!r.ok) throw new Error();
  assert.equal(r.call.calleePlatform, "android");
  s.hangup(st.call.id, "a");
  const st2 = await s.start("a", "b", true, "ca2");
  if (!st2.ok) throw new Error();
  const r2 = await s.accept(st2.call.id, "b", "cb2", "<script>");
  if (!r2.ok) throw new Error();
  assert.equal(r2.call.calleePlatform, undefined);
  s.hangup(st2.call.id, "a");
});

// --- watcher (fake clock / stats) ---
function harness(opts: { levels: number[]; kbpsSeq: number[]; reacquireOk?: boolean[]; muted?: boolean }) {
  const timers: { fn: () => void; ms: number }[] = [];
  let t = 0, bytes = 0, i = 0;
  const logs: { ev: string; x: Record<string, unknown> }[] = [];
  let reacquires = 0;
  const w = new IosMicWatch({
    stats: async () => {
      const k = opts.kbpsSeq[Math.min(i, opts.kbpsSeq.length - 1)], l = opts.levels[Math.min(i, opts.levels.length - 1)];
      i++;
      bytes += (k * 1000) / 8;
      t += 1000;
      return [new Map<string, Record<string, unknown>>([["s", { type: "media-source", kind: "audio", audioLevel: l }], ["o", { type: "outbound-rtp", kind: "audio", bytesSent: bytes }], ["v", { type: "outbound-rtp", kind: "video", bytesSent: 999999 }]]) as unknown as RTCStatsReport];
    },
    reacquire: async () => { const k = reacquires++; return opts.reacquireOk?.[k] ?? true; },
    muted: () => !!opts.muted,
    alive: () => true,
    log: (ev, x) => void logs.push({ ev, x }),
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: () => {},
    now: () => t,
  });
  const run = async (n = 40) => {
    for (let k = 0; k < n && timers.length; k++) {
      const next = timers.shift()!;
      next.fn();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    }
  };
  return { w, logs, run, reacquires: () => reacquires };
}

test("watch: healthy mic → never re-acquires", async () => {
  const h = harness({ levels: [0.1], kbpsSeq: [30] });
  h.w.start(); await h.run();
  assert.equal(h.reacquires(), 0);
  assert.equal(h.logs.length, 0);
});

test("watch: silent ~2 s → one re-acquire, ok logged with before/after levels", async () => {
  // silent for 3 samples, then the new track sends
  const h = harness({ levels: [0, 0, 0, 0.2], kbpsSeq: [0, 0, 0, 0, 32] });
  h.w.start(); await h.run();
  assert.equal(h.reacquires(), 1);
  assert.deepEqual(h.logs.map((l) => l.ev), ["ios-mic-reacquire-start", "ios-mic-reacquire-ok"]);
  assert.equal(h.logs[0].x.beforeLevel, 0);
  assert.ok(Number(h.logs[1].x.afterLevel) > 0);
});

test("watch: stays silent → at most 3 tries, never more, no hangup path", async () => {
  const h = harness({ levels: [0], kbpsSeq: [0] });
  h.w.start(); await h.run(200);
  assert.equal(h.reacquires(), 3);
  assert.equal(h.logs.filter((l) => l.ev === "ios-mic-reacquire-fail").length, 3);
});

test("watch: user-muted silence is never treated as a dead mic", async () => {
  const h = harness({ levels: [0], kbpsSeq: [0], muted: true });
  h.w.start(); await h.run(10);
  assert.equal(h.reacquires(), 0);
});
