import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkRecovery, FIRST_CONNECT_MS } from "../../src/lib/calls/rtc/NetworkRecovery";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function rig() {
  const calls: { n: number; relay: boolean; at: number }[] = [];
  const t0 = Date.now();
  let gaveUp = false;
  const r = new NetworkRecovery({ restart: async (n, relay) => { calls.push({ n, relay, at: Date.now() - t0 }); }, giveUp: () => { gaveUp = true; } });
  return { r, calls, gaveUp: () => gaveUp };
}

test("no restart when connected before 2.5 s", async () => {
  const { r, calls } = rig();
  r.armFirstConnect();
  await sleep(500);
  r.onConnected();
  await sleep(FIRST_CONNECT_MS + 300);
  assert.equal(calls.length, 0);
  r.stop();
});

test("relay-only restart at 2.5 s if never connected, then backoff", async () => {
  const { r, calls } = rig();
  r.armFirstConnect();
  await sleep(FIRST_CONNECT_MS + 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].relay, true);
  assert.ok(calls[0].at >= FIRST_CONNECT_MS - 20);
  r.onTransportState("checking" as RTCIceConnectionState);
  r.onTransportState("failed" as RTCIceConnectionState); // second attempt waits the 1 s backoff step
  await sleep(600);
  assert.equal(calls.length, 1);
  await sleep(600);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].relay, true);
  r.stop();
});

test("ICE connected alone (no DTLS connect) does not clear the first-connect ladder", async () => {
  const { r, calls } = rig();
  r.armFirstConnect();
  r.onTransportState("connected" as RTCIceConnectionState);
  await sleep(FIRST_CONNECT_MS + 200);
  assert.equal(calls.length, 1);
  r.stop();
});

test("after a real connect, drop recovery restarts with policy all", async () => {
  const { r, calls } = rig();
  r.armFirstConnect();
  r.onConnected();
  r.onTransportState("disconnected" as RTCIceConnectionState);
  await sleep(2_700);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].relay, false);
  r.stop();
});

test("stop cancels the first-connect clock", async () => {
  const { r, calls } = rig();
  r.armFirstConnect();
  r.stop();
  await sleep(FIRST_CONNECT_MS + 200);
  assert.equal(calls.length, 0);
});
