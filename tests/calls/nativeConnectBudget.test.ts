// Android 0.3.19 native audio failed the first connect (calls f8729e66 / 0f542027 / fe55fdf2): the deferred native join
// ran its ~6 serial setup requests after the answer and the 5 s first-connect budget cut it off (app timeouts 12 s / 9 s),
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function installWindow(bridge: Record<string, unknown> | null) {
  const target = new EventTarget();
  const w = { OpenLoungeNative: bridge ?? undefined, addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target) };
  (globalThis as { window?: unknown }).window = w;
  return w as typeof w & Record<string, unknown>;
}
function fakeSocket(fail = false) {
  return { on() {}, off() {}, async request(ev: string) { await new Promise((r) => setTimeout(r, 5)); if (fail) throw new Error("boom"); return { ok: true, ev }; } };
}
const engine = () => readFileSync("src/lib/calls/engine.ts", "utf8");

test("native connect budget: native media gets its own 15 s first-connect budget; web keeps 5 s", () => {
  const src = engine();
  assert.match(src, /static NATIVE_FIRST_CONNECT_BUDGET_MS = 15_000;/);
  assert.match(src, /static FIRST_CONNECT_BUDGET_MS = 5_000;/);
  assert.match(src, /const base = this\.mediasoup instanceof NativeMediaSession \? CallEngine\.NATIVE_FIRST_CONNECT_BUDGET_MS : CallEngine\.FIRST_CONNECT_BUDGET_MS;/);
});

test("native connect budget: Android native joins + builds transports while ringing; iOS keeps the deferred join", () => {
  assert.match(engine(), /this\.deferNativeConnect = nativeRingbackMode\(\) !== "off" && !nativeMediaIsAndroid\(\);/);
});

test("native connect budget: every relayed native ms:* step is timed (ok and failed) for call:diag", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  for (const fail of [false, true]) {
    const replies: boolean[] = [];
    const w = installWindow({ platform: "android", capabilities: ["calls", "nativeMedia"], nativeMedia: async () => true, msReply: (_id: string, ok: boolean) => replies.push(ok) });
    const steps: Array<{ event: string; ms: number; ok: boolean; error?: string }> = [];
    const s = new m.NativeMediaSession(fakeSocket(fail) as never, { provider: "mediasoup", callId: "c1" } as never, { onRemoteTrack() {}, onState() {}, onLocalVideo() {}, onStep: (st) => steps.push(st) });
    await s.connect(false);
    (w.__olNativeMsReq as (id: string, ev: string, d: Record<string, unknown>) => void)("r1", "ms:rpc", { callId: "c1", method: "transport:create" });
    await new Promise((r) => setTimeout(r, 30));
    const st = steps.find((x) => x.event === "ms:rpc:transport:create")!;
    assert.ok(st, JSON.stringify(steps));
    assert.equal(st.ok, !fail);
    assert.ok(st.ms >= 0);
    if (fail) assert.match(st.error ?? "", /boom/);
    assert.deepEqual(replies, [!fail]);
    s.close();
  }
  assert.match(engine(), /this\.diag\("native-step", step\)/);
});

test("peer-offline logs carry user id + disconnect reason (close code / cause / liveness)", () => {
  const svc = readFileSync("server/calls/service.ts", "utf8");
  assert.match(svc, /"call peer offline", \{ callId: c\.id, userId: u, who: [^}]*\.\.\.\(this\.d\.lastCloseOf\?\.\(u\) \?\? \{\}\) \}/);
  assert.match(svc, /"call lost", \{ callId: c\.id, userId: lost/);
  const ws = readFileSync("server/ws.ts", "utf8");
  for (const cause of ["heartbeat", "server-drain", "policy", "slow-consumer", "network-abnormal"]) assert.ok(ws.includes(`"${cause}"`), cause);
  const idx = readFileSync("server/calls/index.ts", "utf8");
  assert.match(idx, /"\[calls\] socket closed during call"/);
});
