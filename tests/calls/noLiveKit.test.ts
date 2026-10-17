import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { liveKitAllowed } from "../../server/calls/sfuSelect";

test("CALL_LIVEKIT=off disables LiveKit; default keeps it", () => {
  assert.equal(liveKitAllowed({ CALL_LIVEKIT: "off" }), false);
  assert.equal(liveKitAllowed({}), true);
});

test("both call-start selection and the in-call fallback are gated", () => {
  const src = readFileSync("server/calls/index.ts", "utf8");
  assert.match(src, /selectMedia: \(participants\) => mediasoupBackend\(participants\) \?\? \(liveKitAllowed\(\) \? liveKitBackend\(\) : null\)/);
  assert.match(src, /liveKitFallback: \(\) => \(liveKitAllowed\(\) \? liveKitBackend\(\) : null\)/);
});
