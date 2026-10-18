import { test } from "node:test";
import assert from "node:assert/strict";
import { captureOwner, startupPlan, verifyLive } from "../../src/lib/calls/mediaStartup";

test("one ordered startup plan on every platform, for callers and callees alike", () => {
  const ref = startupPlan({ platform: "web", role: "callee", video: true });
  for (const platform of ["ios-native", "android-webview", "web"] as const)
    for (const role of ["caller", "callee"] as const) assert.deepEqual(startupPlan({ platform, role, video: true }), ref);
  assert.ok(ref.indexOf("capture-mic") < ref.indexOf("connect-transport"));
  assert.ok(ref.indexOf("produce") < ref.indexOf("verify-live"));
  assert.ok(!startupPlan({ platform: "web", role: "caller", video: false }).includes("capture-camera"));
  assert.equal(captureOwner("ios-native"), "native");
  assert.equal(captureOwner("web"), "page");
});

test("verifyLive catches the 2:11 PM failure (muted / zero-energy / no frames) and allows user mute", () => {
  assert.deepEqual(verifyLive({ kind: "audio", readyState: "live", muted: false, enabled: true, level: 0 }), { ok: false, reason: "silent" });
  assert.deepEqual(verifyLive({ kind: "video", readyState: "live", muted: true, enabled: true }), { ok: false, reason: "muted" });
  assert.deepEqual(verifyLive({ kind: "video", readyState: "live", muted: false, enabled: true, frames: 0 }), { ok: false, reason: "no-frames" });
  assert.deepEqual(verifyLive({ kind: "audio", readyState: "ended", muted: false, enabled: true }), { ok: false, reason: "ended" });
  assert.deepEqual(verifyLive({ kind: "audio", readyState: "live", muted: false, enabled: true, level: 0.02 }), { ok: true });
  assert.deepEqual(verifyLive({ kind: "audio", readyState: "live", muted: false, enabled: true, level: 0 }, true), { ok: true });
});
