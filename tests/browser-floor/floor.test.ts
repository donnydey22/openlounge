// Browser floor (last 2 majors of Chrome/Edge/Firefox/Safari), unsupported gate and first-visit supported note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import browserslist from "browserslist";
// @ts-expect-error caniuse-lite ships no types
import * as lite from "caniuse-lite";
import { BROWSER_FLOOR, BROWSERSLIST_FLOOR, belowFloor, detectEngine, gateExempt, shouldShowSupportedNote, unsupportedPageHtml, UPDATE_LINKS, SUPPORTED_NOTE_KEY } from "../../src/lib/browserFloor";

const UA = {
  chrome155: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.8059.79 Safari/537.36",
  chrome154: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.8037.151 Safari/537.36",
  chrome120: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  edge155: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.4283.45",
  edge150: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.4078.96",
  ff158: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0",
  ff157: "Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0",
  ff140esr: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
  safari27: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15",
  safari26: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.4 Safari/605.1.15",
  safari18: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  iosSafari26: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1",
  iosSafari17: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  iosChrome156on26: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0.8078.33 Mobile/15E148 Safari/604.1",
  iosChrome156on17: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0.8078.33 Mobile/15E148 Safari/604.1",
  iosFirefoxOn26: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/158.0 Mobile/15E148 Safari/605.1.15",
  androidChrome155: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.8059.79 Mobile Safari/537.36",
  samsungOnChromium154: "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/30.0 Chrome/154.0.0.0 Mobile Safari/537.36",
  samsungOnChromium130: "Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/130.0.0.0 Mobile Safari/537.36",
  wrapperAndroidOld: "Mozilla/5.0 (Linux; Android 10; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.0.0 Mobile Safari/537.36 OpenLounge/android/0.3.6(18)",
  wrapperIOSOld: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 OpenLounge/ios/0.3.3(23)",
  legacyWrapper: "Mozilla/5.0 (Linux; Android 9; wv) AppleWebKit/537.36 Chrome/90.0 Mobile Safari/537.36 OpenLoungeAndroid",
  bot: "Googlebot/2.1 (+http://www.google.com/bot.html)",
};

test("passes: current and previous major of every browser, by engine", () => {
  for (const k of ["chrome155", "chrome154", "edge155", "ff158", "ff157", "safari27", "safari26", "iosSafari26", "iosChrome156on26", "iosFirefoxOn26", "androidChrome155", "samsungOnChromium154"] as const)
    assert.equal(belowFloor(UA[k]), false, k);
});
test("blocked: older engines (brand doesn't matter: iOS Chrome on old iOS, Samsung on old Chromium, Edge 150)", () => {
  for (const k of ["chrome120", "edge150", "ff140esr", "safari18", "iosSafari17", "iosChrome156on17", "samsungOnChromium130"] as const) assert.equal(belowFloor(UA[k]), true, k);
});
test("never blocked: wrapper apps (OpenLounge/ UA), unknown engines, no UA", () => {
  for (const k of ["wrapperAndroidOld", "wrapperIOSOld", "legacyWrapper", "bot"] as const) assert.equal(belowFloor(UA[k]), false, k);
  assert.equal(belowFloor(""), false);
  assert.equal(belowFloor(undefined), false);
});
test("engine detection: iOS is always WebKit", () => {
  assert.deepEqual(detectEngine(UA.iosChrome156on17).engine, "webkit");
  assert.equal(detectEngine(UA.iosChrome156on17).version, 17);
  assert.equal(detectEngine(UA.samsungOnChromium154).engine, "chromium");
});
test("gate exemptions: /download, legal pages, API, assets stay reachable; app pages are gated", () => {
  for (const p of ["/download", "/download/ios", "/terms", "/privacy", "/privacy-policy", "/api/health", "/_next/static/x.js", "/favicon.ico", "/healthz", "/foo.png"]) assert.equal(gateExempt(p), true, p);
  for (const p of ["/", "/messages", "/settings", "/call/123", "/room/abc", "/downloads-other"]) assert.equal(gateExempt(p), false, p);
});
test("gate page: exact 3-line copy, no exclamation points, 4 official links, platform Safari link", () => {
  const h = unsupportedPageHtml(UA.safari18);
  assert.match(h, /<h1>Your browser isn't supported\.<\/h1>/);
  assert.match(h, /<p>Open Lounge needs a current version of Chrome, Firefox, Safari, or Edge\.<\/p>/);
  assert.match(h, /<p>Update it from your browser's settings or download page, then reload\.<\/p>/);
  assert.doesNotMatch(h.replace(/<!doctype/i, ""), /!/);
  assert.doesNotMatch(h, /<script/i);
  for (const u of [UPDATE_LINKS.chrome, UPDATE_LINKS.firefox, UPDATE_LINKS.safariMac, UPDATE_LINKS.edge]) assert.ok(h.includes(`href="${u}"`), u);
  assert.ok(unsupportedPageHtml(UA.iosSafari17).includes(UPDATE_LINKS.safariIOS));
});
test("server wires the gate before Next for HTML navigations", () => {
  const s = readFileSync("server/index.ts", "utf8");
  assert.match(s, /!gateExempt\(p\) && belowFloor\(ua\)/);
  assert.match(s, /unsupportedPageHtml\(ua\)/);
});
test("supported note: first visit only, supported browsers only, never in wrappers", () => {
  const empty = { getItem: () => null };
  const seen = { getItem: (k: string) => (k === SUPPORTED_NOTE_KEY ? "1" : null) };
  assert.equal(shouldShowSupportedNote(UA.chrome155, empty), true);
  assert.equal(shouldShowSupportedNote(UA.iosSafari26, empty), true);
  assert.equal(shouldShowSupportedNote(UA.chrome155, seen), false);
  assert.equal(shouldShowSupportedNote(UA.wrapperAndroidOld, empty), false);
  assert.equal(shouldShowSupportedNote(UA.androidChrome155 + " OpenLounge/android/0.3.6(18)", empty), false);
  assert.equal(shouldShowSupportedNote(UA.chrome120, empty), false);
  assert.equal(shouldShowSupportedNote(UA.bot, empty), false);
  const c = readFileSync("src/components/BrowserSupportedNote.tsx", "utf8");
  assert.match(c, /banner\(\{ title: "Your browser is supported\."/);
  assert.match(readFileSync("src/app/layout.tsx", "utf8"), /<BrowserSupportedNote \/>/);
});
test("package.json browserslist == the floor", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.deepEqual(pkg.browserslist, BROWSERSLIST_FLOOR);
  const mins = new Map<string, number>();
  for (const e of browserslist(pkg.browserslist)) {
    const [b, v] = e.split(" ");
    const n = parseFloat(v.split("-")[0]);
    mins.set(b, Math.min(mins.get(b) ?? Infinity, n));
  }
  assert.equal(mins.get("chrome"), BROWSER_FLOOR.chromium);
  assert.equal(mins.get("edge"), BROWSER_FLOOR.chromium);
  assert.equal(mins.get("firefox"), BROWSER_FLOOR.firefox);
  assert.ok((mins.get("safari") ?? 0) >= BROWSER_FLOOR.webkit && (mins.get("safari") ?? 99) < BROWSER_FLOOR.webkit + 1);
  assert.ok((mins.get("ios_saf") ?? 0) >= BROWSER_FLOOR.webkit && (mins.get("ios_saf") ?? 99) < BROWSER_FLOOR.webkit + 1);
});
test("call/video stack features are fully supported at the floor (caniuse data)", () => {
  const targets = browserslist(BROWSERSLIST_FLOOR);
  for (const f of ["viewport-unit-variants", "css-env-function", "css-has", "css-nesting", "rtcpeerconnection", "mediasource", "canvas"]) {
    const data = lite.feature(lite.features[f]);
    for (const t of targets) {
      const [b, v] = t.split(" ");
      const st = data.stats[b]?.[v];
      if (st === undefined) continue; // version newer than local caniuse data
      // iOS has ManagedMediaSource (partial "a"), which hls.js 1.7 uses; adaptive.ts also falls back to native HLS
      if (f === "mediasource" && b === "ios_saf") assert.match(st, /^[ya]/, `${f} on ${t}: ${st}`);
      else assert.match(st, /^y/, `${f} on ${t}: ${st}`);
    }
  }
});

test("Safari 18.4/18.5 (LambdaTest macOS) is gated on every page-navigation shape, incl. Accept */* and /index.html", async () => {
  const { isPageNavigation, gateExempt } = await import("../../src/lib/browserFloor");
  const lt184 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15";
  assert.equal(belowFloor(lt184), true);
  assert.equal(isPageNavigation("GET", { accept: "*/*" }), true);
  assert.equal(isPageNavigation("GET", {}), true);
  assert.equal(isPageNavigation("GET", { accept: "*/*", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" }), true);
  assert.equal(isPageNavigation("GET", { accept: "*/*", "sec-fetch-dest": "script" }), false);
  assert.equal(isPageNavigation("GET", { accept: "*/*", rsc: "1" }), false);
  assert.equal(isPageNavigation("POST", { accept: "text/html" }), false);
  assert.equal(gateExempt("/index.html"), false);
  assert.equal(gateExempt("/download"), true);
  assert.equal(gateExempt("/app.js"), true);
});
