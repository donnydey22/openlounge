import test from "node:test";
import assert from "node:assert/strict";
import { nextElsewhere } from "../../src/lib/calls/elsewhere";
import type { CallInfo } from "../../src/lib/types";

const call = (phase: CallInfo["phase"], over: Partial<CallInfo> = {}): CallInfo => ({
  id: "c1", callerId: "a", calleeId: "b", video: false, phase, createdAt: 0, answeredAt: phase === "active" ? 5 : null, endedAt: null, outcome: null, expiresAt: 45_000,
  caller: { id: "a", name: "Ana Smith", color: "#000", photoUrl: null }, callee: { id: "b", name: "Ben Jones", color: "#000", photoUrl: null }, ...over,
});

test("callee's non-answering device shows 'on a call with Ana on another device', clears on hang-up", () => {
  let e = nextElsewhere(null, call("ringing"), "b", false, 100);
  assert.equal(e, null, "ringing is not an in-call indicator");
  e = nextElsewhere(e, call("active"), "b", false, 100);
  assert.deepEqual(e, { callId: "c1", peerName: "Ana", video: false, since: 100 });
  assert.equal(nextElsewhere(e, call("active"), "b", false, 999), e, "stable across repeated states");
  assert.equal(nextElsewhere(e, call("ended"), "b", false), null);
});

test("caller's other device shows the indicator naming the callee; the device in the call never does", () => {
  assert.equal(nextElsewhere(null, call("active"), "a", false, 1)?.peerName, "Ben");
  assert.equal(nextElsewhere(null, call("active"), "a", true, 1), null);
});

test("other people's calls are ignored", () => {
  assert.equal(nextElsewhere(null, call("active"), "z", false), null);
});
