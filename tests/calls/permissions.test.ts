import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { ensureCallReadyWeb, webHint } from "../../src/lib/calls/permissions/web";
import { ensureCallReadyAndroid } from "../../src/lib/calls/permissions/android";
import { ensureCallReadyIos } from "../../src/lib/calls/permissions/ios";
import type { PermState, Probe } from "../../src/lib/calls/permissions/types";

const probe = (mic: PermState, cam: PermState = "granted"): Probe => ({ query: async (n) => (n === "microphone" ? mic : cam) });
const FF = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
const SAF = "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
const CHR = "Mozilla/5.0 (X11) AppleWebKit/537.36 Chrome/141 Safari/537.36";

test("web: only a known mic denial blocks; prompt/unknown proceed to getUserMedia; per-browser hints", async () => {
  assert.equal((await ensureCallReadyWeb({ video: false }, probe("prompt"), CHR)).ok, true);
  assert.equal((await ensureCallReadyWeb({ video: false }, probe("unknown"), FF)).ok, true);
  const d = await ensureCallReadyWeb({ video: false }, probe("denied"), SAF);
  assert.equal(d.ok, false);
  assert.match(d.hint!, /Safari/);
  assert.match(webHint(FF, "microphone"), /address bar/);
  const cam = await ensureCallReadyWeb({ video: true }, probe("granted", "denied"), CHR);
  assert.equal(cam.ok, true, "denied camera falls back to audio");
  assert.match(cam.hint!, /Camera/);
});

test("android: bridge state wins, settings deep link offered, Android wording", async () => {
  const r = await ensureCallReadyAndroid({ video: false }, { micPermission: () => "denied", openAppSettings: () => {} }, probe("granted"));
  assert.deepEqual([r.platform, r.ok, r.canOpenSettings], ["android", false, true]);
  assert.match(r.hint!, /Apps ▸ Open Lounge/);
  assert.equal((await ensureCallReadyAndroid({ video: false }, null, probe("prompt"))).ok, true);
});

test("ios: WKWebView 'undetermined' = prompt (not denied); denied → iOS Settings wording", async () => {
  assert.equal((await ensureCallReadyIos({ video: false }, { micPermission: () => "undetermined" }, probe("denied"))).ok, true);
  const r = await ensureCallReadyIos({ video: true }, { micPermission: () => "denied" }, probe("granted"));
  assert.equal(r.ok, false);
  assert.match(r.hint!, /Settings ▸ Open Lounge ▸ Microphone/);
});

test("no shared path: platform modules never import each other", () => {
  const dir = new URL("../../src/lib/calls/permissions/", import.meta.url);
  for (const f of ["web.ts", "android.ts", "ios.ts"]) {
    const src = readFileSync(new URL(f, dir), "utf8");
    for (const other of ["./web", "./android", "./ios"]) if (!f.startsWith(other.slice(2))) assert.ok(!src.includes(`"${other}"`), `${f} imports ${other}`);
  }
  assert.deepEqual(readdirSync(dir).sort(), ["android.ts", "index.ts", "ios.ts", "types.ts", "web.ts"]);
});
