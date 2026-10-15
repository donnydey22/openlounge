// iOS 0.3.12 b31 (Oct 15 13:24 PT): native ringback died right after CallKit activation → silent "Calling…".
// Web must not trust flag 1 on iOS; flag 2 (0.3.13+) is trusted only while native reports playing.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const w = globalThis as unknown as { window?: Record<string, unknown> };
w.window = { addEventListener() {} } as Record<string, unknown>;
let T: typeof import("../../src/lib/calls/tones");
test.before(async () => { T = await import("../../src/lib/calls/tones"); });
const nativeRingbackMode = () => T.nativeRingbackMode();
const set = (platform: string | null, flag: unknown) => {
  w.window!.OpenLoungeNative = platform ? { getPlatform: () => platform } : undefined;
  w.window!.__olNativeRingback = flag;
};

test("browsers / no flag → web ring", () => { set(null, undefined); assert.equal(nativeRingbackMode(), "off"); });
test("iOS 0.3.12 (flag 1) is not trusted → web ring", () => { set("ios", 1); assert.equal(nativeRingbackMode(), "off"); });
test("Android 0.3.12 (flag 1) keeps native ToneGenerator", () => { set("android", 1); assert.equal(nativeRingbackMode(), "trust"); });
test("0.3.13+ (flag 2) → verified: web takes over unless native reports playing", () => { set("ios", 2); assert.equal(nativeRingbackMode(), "verified"); });
test("takeover windows: confirm within 4 s, gap ≤ 1.5 s; takeover tells native to stop (one owner)", () => {
  assert.equal(T.NATIVE_CONFIRM_MS, 4000);
  assert.equal(T.NATIVE_GAP_MS, 1500);
  const src = readFileSync("src/lib/calls/tones.ts", "utf8");
  assert.match(src, /if \(neverStarted \|\| stopped\) \{[\s\S]{0,120}postNativeRingbackStop\(\);[\s\S]{0,120}startRing\(kind, \{ \.\.\.opts, webOnly: true \}\)/);
  assert.match(src, /"openlounge:native-ringback"/);
});
