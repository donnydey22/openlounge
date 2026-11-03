import test from "node:test"; import assert from "node:assert/strict";
import { plainTransportOptions, pickVideoCodec, simulcastProducerParams, topLayerCap, SIMULCAST } from "../src/plain.mjs";
import { LAYER_POLICY } from "../src/layers.mjs";
test("PlainTransport: comedia, rtcp-mux, SRTP 128_80, no ICE", () => { const o = plainTransportOptions();
  assert.equal(o.comedia, true); assert.equal(o.rtcpMux, true); assert.equal(o.srtpCryptoSuite, "AES_CM_128_HMAC_SHA1_80"); });
test("AV1 only when both ends have hardware AV1", () => {
  assert.equal(pickVideoCodec({ hwAv1: true }, { hwAv1: true }), "av1"); assert.equal(pickVideoCodec({ hwAv1: true }, {}), "h264"); assert.equal(pickVideoCodec(), "h264"); });
test("3-layer simulcast matches SFU layer policy", () => { const p = simulcastProducerParams({ ssrcs: [1, 2, 3] });
  assert.equal(p.codecs[0].mimeType, "video/H264"); assert.deepEqual(p.encodings.map((e) => e.maxBitrate), LAYER_POLICY.layerBps);
  assert.equal(simulcastProducerParams({ codec: "av1", ssrcs: [1, 2, 3] }).codecs[0].mimeType, "video/AV1"); });
test("QuickHD burst then steady", () => { assert.ok(topLayerCap(0) > SIMULCAST[2].maxBitrate); assert.equal(topLayerCap(10_000), SIMULCAST[2].maxBitrate); });
