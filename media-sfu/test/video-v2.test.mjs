import test from "node:test"; import assert from "node:assert/strict";
import { LAYER_POLICY, nextLayer } from "../src/layers.mjs";
import { LADDERS, PEER_TRANSPORTS, simulcastProducerParams, BROWSER_VIDEO } from "../src/plain.mjs";
test("v2 policy: 1 s tick, down on >2% loss, up after 5 clean s", () => {
  assert.equal(LAYER_POLICY.sampleMs, 1000);
  assert.equal(nextLayer({ spatial: 2 }, { lossPct: 2 }).spatial, 2);
  assert.equal(nextLayer({ spatial: 2 }, { lossPct: 2.1 }).spatial, 1);
  let st = { spatial: 1 }; for (let i = 0; i < 4; i++) { st = nextLayer(st, { lossPct: 0 }); assert.equal(st.spatial, 1); }
  assert.equal(nextLayer(st, { lossPct: 0 }).spatial, 2);
});
test("v2 ladders: iOS 150/800/2400, Android 120/600/1600, browser 720p single layer", () => {
  assert.deepEqual(simulcastProducerParams({ ssrcs: [1, 2, 3], platform: "ios" }).encodings.map((e) => e.maxBitrate), [150_000, 800_000, 2_400_000]);
  assert.deepEqual(simulcastProducerParams({ ssrcs: [1, 2, 3], platform: "android" }).encodings.map((e) => e.maxBitrate), [120_000, 600_000, 1_600_000]);
  assert.deepEqual(LADDERS.ios.map((l) => l.height), [180, 720, 1080]);
  assert.equal(BROWSER_VIDEO.height, 720); assert.equal(BROWSER_VIDEO.layers, 1);
  assert.deepEqual([...PEER_TRANSPORTS], ["audio", "video", "backup"]);
});
test("v2 layer tick inputs: producer advertises REMB + transport-cc feedback", () => {
  const fb = simulcastProducerParams({ ssrcs: [1, 2, 3] }).codecs[0].rtcpFeedback.map((f) => f.type);
  assert.ok(fb.includes("goog-remb") && fb.includes("transport-cc"));
});
