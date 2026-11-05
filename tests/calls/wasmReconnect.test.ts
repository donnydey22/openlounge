// tweb parity (Donny 10:16 PM): the web WASM leg's media-WS recovery mirrors tweb connectionRecovery.ts —
// restart after 2 s down, retry every 5 s, hang up ("failed") after 45 s, clear everything on recovery.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0; binaryType = ""; url: string;
  onopen: (() => void) | null = null; onclose: ((e: { code: number }) => void) | null = null; onmessage: unknown = null;
  constructor(url: string) { this.url = url; FakeWS.all.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
  close() { this.readyState = 3; }
  send() {}
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;

test("media WS recovery: 2 s restart, 5 s retries, same URL, 45 s give-up, recovery clears", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const { WasmCallSession, P2P_ICE_DISCONNECTED_RESTART_DELAY_MS, P2P_ICE_RESTART_MIN_INTERVAL_MS, CALL_REQUEST_TIMEOUT } = await import("../../src/lib/calls/wasmCallSession");
  assert.deepEqual([P2P_ICE_DISCONNECTED_RESTART_DELAY_MS, P2P_ICE_RESTART_MIN_INTERVAL_MS, CALL_REQUEST_TIMEOUT], [2000, 5000, 45000]);
  const states: string[] = []; const sent: string[] = [];
  const socket = { request: async (ev: string) => { sent.push(ev); return {}; }, on() {}, off() {} };
  const s = new WasmCallSession(socket as never, { callId: "c" } as never, { onState: (x) => states.push(x) });
  const p = s as unknown as { wsUrl: string; hasConnected: boolean; openMediaWs(): Promise<void> };
  p.wsUrl = "wss://relay/?token=T&callId=c";
  const first = p.openMediaWs(); FakeWS.all[0].open(); await first; p.hasConnected = true;

  // drop -> "disconnected" now, no restart before 2 s
  FakeWS.all[0].drop();
  assert.deepEqual(states, ["disconnected"]);
  mock.timers.tick(1999); assert.equal(FakeWS.all.length, 1);
  mock.timers.tick(1); assert.equal(FakeWS.all.length, 2, "restart at 2 s");
  assert.equal(FakeWS.all[1].url, p.wsUrl, "same relay URL + token");
  // attempt fails, still down -> retry every 5 s (an attempt still connecting is left to finish, tweb :327-334)
  FakeWS.all[1].drop(); assert.equal(states.length, 1, "a failed attempt does not re-signal");
  mock.timers.tick(5000); assert.equal(FakeWS.all.length, 3);
  FakeWS.all[2].drop();
  mock.timers.tick(5000); assert.equal(FakeWS.all.length, 4);
  // recovers -> connected, timers cleared (no more restarts, no give-up)
  FakeWS.all[3].open();
  assert.equal(states.at(-1), "connected");
  mock.timers.tick(60_000); assert.equal(FakeWS.all.length, 4); assert.ok(!states.includes("failed"));

  // second drop that never recovers -> "failed" at 45 s
  FakeWS.all[3].drop();
  for (let t = 0; t < 44_999; t += 1000) { mock.timers.tick(Math.min(1000, 44_999 - t)); const w = FakeWS.all.at(-1)!; if (w.readyState === 0) w.drop(); }
  assert.ok(!states.includes("failed"));
  mock.timers.tick(1); assert.equal(states.at(-1), "failed");
  const n = FakeWS.all.length; mock.timers.tick(30_000); assert.equal(FakeWS.all.length, n, "no restarts after give-up");
  assert.deepEqual(sent, [], "no server messages during recovery");
  s.close(); mock.timers.reset();
});
