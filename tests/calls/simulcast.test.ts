import { test } from "node:test";
import assert from "node:assert/strict";
import { isSimulcastConsumer, layerForTile, maxLayerForNetwork, simulcastEncodings } from "../../src/lib/calls/simulcast";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const IOS_WV = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
const ANDROID_WV = "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36";

test("three layers low→high with rising bitrate", () => {
  for (const ua of [CHROME, SAFARI, IOS_WV, FIREFOX, ANDROID_WV]) {
    const e = simulcastEncodings({ ua })!;
    assert.equal(e.length, 3);
    assert.deepEqual(e.map((x) => x.scaleResolutionDownBy), [4, 2, 1]);
    assert.ok(e[0].maxBitrate! < e[1].maxBitrate!);
    assert.equal(e[2].maxBitrate, undefined, "top layer uncapped");
  }
});

test("scalabilityMode only on Chromium engines", () => {
  assert.equal(simulcastEncodings({ ua: CHROME })![0].scalabilityMode, "L1T3");
  assert.equal(simulcastEncodings({ ua: ANDROID_WV })![0].scalabilityMode, "L1T3");
  for (const ua of [SAFARI, IOS_WV, FIREFOX]) assert.equal(simulcastEncodings({ ua })![0].scalabilityMode, undefined);
});

test("tile size → layer", () => {
  assert.equal(layerForTile(144, 256, 2), 0); // phone PiP
  assert.equal(layerForTile(390, 844, 3), 2); // phone stage
  assert.equal(layerForTile(800, 450, 1), 2); // desktop stage
  assert.equal(layerForTile(360, 200, 1), 0);
  assert.equal(layerForTile(640, 360, 1), 1);
  assert.equal(layerForTile(0, 0, 1), 0);
  assert.equal(layerForTile(800, 450, 1, 1), 1); // network cap
});

test("network cap", () => {
  assert.equal(maxLayerForNetwork("normal", 0), 2);
  assert.equal(maxLayerForNetwork("low", 0), 1);
  assert.equal(maxLayerForNetwork("normal", 0.04), 2);
  assert.equal(maxLayerForNetwork("normal", 0.08), 1);
  assert.equal(maxLayerForNetwork("normal", 0.2), 0);
});

test("detect simulcast consumer", () => {
  assert.equal(isSimulcastConsumer({ encodings: [{ scalabilityMode: "S3T3" }] }), true);
  assert.equal(isSimulcastConsumer({ encodings: [{ scalabilityMode: "L3T3" }] }), true);
  assert.equal(isSimulcastConsumer({ encodings: [{ scalabilityMode: "L1T3" }] }), false);
  assert.equal(isSimulcastConsumer({ encodings: [{}] }), false);
});

test("layer count follows the captured frame", () => {
  assert.equal(simulcastEncodings({ ua: CHROME }, { width: 1280, height: 720 })!.length, 3);
  assert.equal(simulcastEncodings({ ua: ANDROID_WV }, { width: 640, height: 480 })!.length, 2);
  assert.equal(simulcastEncodings({ ua: ANDROID_WV }, { width: 480, height: 640 })![1].scaleResolutionDownBy, 1);
  assert.equal(simulcastEncodings({ ua: CHROME }, { width: 320, height: 180 }), null);
});
