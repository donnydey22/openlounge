import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AndroidCallLifecycle, classify, summarizeStats, LIFECYCLE, type LifecycleDeps, type LifecycleHealth } from "../../src/lib/calls/androidLifecycle";

function deps(over: Partial<LifecycleDeps> & { healthSeq?: (LifecycleHealth | null)[] } = {}) {
  const calls: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  let t = 0;
  const seq = over.healthSeq ?? [{ ice: "connected", inboundPackets: 100 }];
  let i = 0;
  const d: LifecycleDeps = {
    audioEls: () => [],
    audioContexts: () => [],
    micTrack: () => null,
    recoverMic: async () => { calls.push("mic"); },
    health: async () => seq[Math.min(i++, seq.length - 1)],
    restartIce: async () => { calls.push("ice"); },
    escalate: (r) => calls.push(`escalate:${r}`),
    busyRecovering: () => false,
    visible: () => true,
    log: (ev, x) => logs.push({ ev, ...x }),
    now: () => t,
    ...over,
  };
  return { d, calls, logs, advance: (ms: number) => { t += ms; } };
}

test("classify: killed vs paused (spec §2)", () => {
  const base = { ctxStates: ["running"], ctxResumeFailed: false, micState: "live" as const, remoteEnded: false, ice: "connected" as const, gapMs: 0 };
  assert.equal(classify(base).kind, "ok");
  assert.deepEqual(classify({ ...base, ctxStates: ["suspended"] }), { kind: "paused", why: "audio-context" });
  assert.deepEqual(classify({ ...base, ctxStates: ["closed"] }), { kind: "killed", why: "audio-context" });
  assert.deepEqual(classify({ ...base, ctxResumeFailed: true }), { kind: "killed", why: "audio-context" });
  assert.deepEqual(classify({ ...base, micState: "muted" }), { kind: "paused", why: "mic-muted" });
  assert.deepEqual(classify({ ...base, micState: "ended" }), { kind: "killed", why: "mic-ended" });
  assert.deepEqual(classify({ ...base, remoteEnded: true }), { kind: "killed", why: "remote-ended" });
  assert.deepEqual(classify({ ...base, ice: "disconnected" }), { kind: "paused", why: "ice-disconnected" });
  assert.deepEqual(classify({ ...base, ice: "failed" }), { kind: "killed", why: "ice-failed" });
  assert.deepEqual(classify({ ...base, ice: "disconnected", gapMs: 12_000 }), { kind: "killed", why: "long-freeze" });
  assert.deepEqual(classify({ ...base, gapMs: 5_000 }), { kind: "paused", why: "frozen" });
});

test("foreground return: resumes suspended AudioContext and replays paused voice; healthy -> no ICE restart", async () => {
  let resumed = 0;
  let played = 0;
  const ctx = { state: "suspended" as AudioContextState, resume: async () => { resumed++; ctx.state = "running"; } };
  const el = { paused: true, play: async () => { played++; }, srcObject: null } as unknown as HTMLMediaElement;
  const { d, calls, logs } = deps({ audioContexts: () => [ctx as never], audioEls: () => [el] });
  await new AndroidCallLifecycle(d).run("visibilitychange", 0);
  assert.equal(resumed, 1);
  assert.equal(played, 1);
  assert.deepEqual(calls, [], "healthy after resume: nothing else");
  assert.equal(logs.length, 0, "no bg time recorded: nothing to report");
});

test("ladder: muted mic -> replaceTrack re-acquire; ICE down -> ICE restart -> still down -> existing recovery; diag fields", async () => {
  const mic = { readyState: "live", muted: true } as MediaStreamTrack;
  const { d, calls, logs } = deps({
    micTrack: () => mic,
    healthSeq: [{ ice: "disconnected", inboundPackets: 5 }, { ice: "disconnected", inboundPackets: 5 }],
  });
  const orig = LIFECYCLE.ICE_WAIT_MS;
  LIFECYCLE.ICE_WAIT_MS = 50;
  try {
    await new AndroidCallLifecycle(d).run("resume", 0);
  } finally {
    LIFECYCLE.ICE_WAIT_MS = orig;
  }
  assert.deepEqual(calls, ["mic", "ice", "escalate:lifecycle-ice-disconnected"]);
  const l = logs.at(-1)!;
  assert.equal(l.ev, "lifecycle");
  assert.equal(l.path, "resume>mic>ice>escalate");
  for (const k of ["bgMs", "maxGapMs", "recoveryMs", "verdict", "trig"]) assert.ok(k in l, k);
});

test("ladder: ICE restart recovers -> no escalation", async () => {
  const { d, calls } = deps({ healthSeq: [{ ice: "disconnected", inboundPackets: 5 }, { ice: "connected", inboundPackets: 9 }] });
  await new AndroidCallLifecycle(d).run("gap", 4_000);
  assert.deepEqual(calls, ["ice"]);
});

test("engine already recovering: the ladder stays out of its way", async () => {
  const { d, calls, logs } = deps({ busyRecovering: () => true, healthSeq: [{ ice: "failed", inboundPackets: 0 }] });
  await new AndroidCallLifecycle(d).run("resume", 0);
  assert.deepEqual(calls, []);
  assert.equal(logs.at(-1)!.path, "resume>engine");
});

test("hidden: never re-acquires the mic in the background (Android 10)", async () => {
  const mic = { readyState: "ended", muted: false } as MediaStreamTrack;
  const { d, calls } = deps({ micTrack: () => mic, visible: () => false });
  await new AndroidCallLifecycle(d).run("gap", 0);
  assert.ok(!calls.includes("mic"));
});

test("heartbeat: a tick gap > 3 s counts as freeze and is recorded as maxGapMs", async () => {
  const h = deps();
  const lc = new AndroidCallLifecycle(h.d);
  h.advance(1_000); lc.tick();
  h.advance(7_000); lc.tick();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lc.summary().maxGapMs, 7_000);
  assert.equal(h.logs.at(-1)?.trig, "gap");
});

test("stalled media: no inbound packets for 4 s with ICE connected -> one in-place ICE restart, never escalates, 30 s cooldown", async () => {
  const h = deps({ healthSeq: [{ ice: "connected", inboundPackets: 50 }] });
  const lc = new AndroidCallLifecycle(h.d);
  await lc.pollStats();
  h.advance(2_000); await lc.pollStats();
  h.advance(2_000); await lc.pollStats();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.calls, ["ice"]);
  h.advance(2_000); await lc.pollStats();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h.calls, ["ice"], "cooldown");
});

test("summarizeStats: worst ICE across transports + inbound audio packets", () => {
  const r1 = new Map<string, unknown>([["t", { type: "transport", iceState: "connected" }], ["i", { type: "inbound-rtp", kind: "audio", packetsReceived: 10 }]]);
  const r2 = new Map<string, unknown>([["t", { type: "transport", dtlsState: "failed" }]]);
  assert.deepEqual(summarizeStats([r1 as never]), { ice: "connected", inboundPackets: 10 });
  assert.deepEqual(summarizeStats([r1 as never, r2 as never]), { ice: "failed", inboundPackets: 10 });
  assert.equal(summarizeStats([]), null);
});

test("engine: lifecycle only for the Android app on the WebView mediasoup session; stopped on drop/teardown", () => {
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.ok(src.includes("if (!isAndroidApp() || !(session instanceof MediasoupCallSession)) return;"));
  assert.ok((src.match(/this\.stopAndroidLifecycle\(\);/g) ?? []).length >= 3);
  assert.ok(src.includes('this.onMediasoupState("failed");'), "escalation = existing recovery path");
});
