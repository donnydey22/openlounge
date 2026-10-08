// Which sign-in buttons each platform gets (Donny's rule): iOS app → Apple only (no Google); Android app → Google only
// (no Apple); desktop + mobile web (incl. iOS Safari) → both, unchanged. Detection prefers the wrapper's bridge, then its
// user-agent suffix; plain browsers are never treated as an app.
import { test } from "node:test";
import assert from "node:assert/strict";

const UA = {
  iosApp: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 OpenLoungeiOS/0.3.1 OpenLoungeExpo/0.3.1",
  iPadApp: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) OpenLoungeiOS/0.3.1 OpenLoungeExpo/0.3.1",
  androidApp: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 OpenLoungeAndroid/0.3.2",
  iosSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  iPadSafari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36",
  desktopChrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
  firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
};

function env(ua: string, bridge?: Record<string, unknown>) {
  const g = globalThis as Record<string, unknown>;
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: ua }, configurable: true, writable: true });
  g.window = bridge ? { OpenLoungeNative: bridge } : {};
  g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  g.sessionStorage = g.localStorage;
}

test("platform → which OAuth buttons", async () => {
  const { nativePlatform, showAppleHere, showGoogleHere } = await import("../../src/lib/authApi");
  const want = (ua: string, bridge: Record<string, unknown> | undefined, platform: string | null, apple: boolean, google: boolean) => {
    env(ua, bridge);
    assert.deepEqual([nativePlatform(), showAppleHere(), showGoogleHere()], [platform, apple, google], ua.slice(0, 60) + " bridge=" + JSON.stringify(bridge && Object.keys(bridge)));
  };
  const iosBridge = { __expo: true, platform: "ios", getPlatform: () => "ios", openAuth() {} };
  const androidBridge = { getPlatform: () => "android", openAuth() {} };
  // apps: bridge + UA suffix, either one alone is enough
  want(UA.iosApp, iosBridge, "ios", true, false);
  want(UA.iosApp, undefined, "ios", true, false); // UA suffix only (bridge not injected yet)
  want(UA.iPadApp, undefined, "ios", true, false); // iPadOS desktop-class UA still carries the suffix
  want(UA.iosSafari, { platform: "ios" }, "ios", true, false); // bridge property only
  want(UA.androidApp, androidBridge, "android", false, true);
  want(UA.androidApp, undefined, "android", false, true);
  // plain browsers: web rules unchanged (Apple + Google)
  for (const ua of [UA.iosSafari, UA.iPadSafari, UA.androidChrome, UA.desktopChrome, UA.firefox]) want(ua, undefined, null, true, true);
  // a throwing bridge falls back to the UA suffix
  want(UA.iosApp, { getPlatform: () => { throw new Error("x"); } }, "ios", true, false);
});
