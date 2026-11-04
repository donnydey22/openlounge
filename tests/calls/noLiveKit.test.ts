import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { liveKitAllowed, sfuSelected } from "../../server/calls/sfuSelect";

// 11/4 (Donny): no call ever uses LiveKit — not at start, not as an in-call fallback, whatever the env says.
test("LiveKit calling is off regardless of env", () => {
  for (const env of [{}, { CALL_LIVEKIT: "on" }, { CALL_LIVEKIT: "off" }]) assert.equal(liveKitAllowed(env), false);
});
test("every pairing selects the SFU", () => {
  for (const env of [{}, { CALL_SFU: "" }, { CALL_SFU_TEST_USERS: "u_z" }]) assert.equal(sfuSelected({ callerId: "u_a", calleeId: "u_b" }, env), true);
  assert.equal(sfuSelected(undefined, {}), true);
});
test("server never wires a LiveKit call backend or fallback", () => {
  const idx = readFileSync("server/calls/index.ts", "utf8");
  assert.match(idx, /selectMedia: \(participants\) => mediasoupBackend\(participants\),/);
  assert.match(idx, /liveKitFallback: \(\) => null,/);
  const svc = readFileSync("server/calls/service.ts", "utf8");
  assert.match(svc, /selectMedia\?\.\(participants\) \?\? null;/);
  assert.doesNotMatch(svc, /liveKitFallback\?\.\(\) \?\? this\.legacyLiveKit\(\)/);
  assert.match(readFileSync("src/lib/calls/engine.ts", "utf8"), /livekit-call-refused/);
});
