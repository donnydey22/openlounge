import test from "node:test";
import assert from "node:assert/strict";
import { appBuildLabel, parseAppBuild, uaLooksNative, uaNativePlatform } from "../../src/lib/appBuild";

test("parses new OpenLounge/<platform>/<version>(<build>) UA suffix", () => {
  const a = parseAppBuild("Mozilla/5.0 OpenLounge/android/0.3.6(18)");
  assert.deepEqual(a, { kind: "native", platform: "Android", version: "0.3.6", build: "18" });
  assert.equal(appBuildLabel(a), "Open Lounge 0.3.6 (18) · Android");
  const i = parseAppBuild("Mozilla/5.0 OpenLounge/ios/0.3.3(23)");
  assert.deepEqual(i, { kind: "native", platform: "iOS", version: "0.3.3", build: "23" });
  assert.equal(appBuildLabel(i), "Open Lounge 0.3.3 (23) · iOS");
  assert.equal(uaNativePlatform("… OpenLounge/ios/0.3.3(23)"), "ios");
  assert.equal(uaLooksNative("… OpenLounge/android/0.3.6(18)"), true);
});

test("parses legacy OpenLoungeAndroid / OpenLoungeiOS suffixes", () => {
  assert.deepEqual(parseAppBuild("x OpenLoungeAndroid/0.3.5"), { kind: "native", platform: "Android", version: "0.3.5", build: "" });
  assert.equal(appBuildLabel(parseAppBuild("x OpenLoungeiOS/0.3.3")), "Open Lounge 0.3.3 · iOS");
  assert.equal(uaNativePlatform("OpenLoungeAndroid/0.3.6"), "android");
});

test("plain web falls back to short commit when set", () => {
  const prev = process.env.NEXT_PUBLIC_GIT_COMMIT;
  process.env.NEXT_PUBLIC_GIT_COMMIT = "48b47834fd01244885d1a79f059890b37cbcc981";
  try {
    const w = parseAppBuild("Mozilla/5.0 (Macintosh) AppleWebKit/537.36");
    assert.deepEqual(w, { kind: "web", commit: "48b4783" });
    assert.equal(appBuildLabel(w), "Open Lounge web · 48b4783");
  } finally {
    if (prev === undefined) delete process.env.NEXT_PUBLIC_GIT_COMMIT;
    else process.env.NEXT_PUBLIC_GIT_COMMIT = prev;
  }
});
