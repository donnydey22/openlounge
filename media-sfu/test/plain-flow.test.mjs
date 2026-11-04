import test from "node:test"; import assert from "node:assert/strict";
import { handlePlainRpc } from "../src/plain.mjs";
// Full two-phone PJSIP flow as NativeCallMedia (Android, M4 option B) drives it: create -> connect -> produce -> consume.
let n = 0;
const fakeTransport = () => { const t = { id: `t${++n}`, tuple: { localIp: "10.0.0.1", localPort: 40000 + n }, srtpParameters: { cryptoSuite: "AES_CM_128_HMAC_SHA1_80", keyBase64: "S".repeat(40) },
  connected: null, close() {}, async connect(o) { t.connected = o; },
  async produce({ kind, rtpParameters }) { return { id: `p${++n}`, kind, rtpParameters, close() {} }; },
  async consume({ producerId }) { return { id: `c${++n}`, kind: "audio", on() {}, close() {}, requestKeyFrame: async () => {}, rtpParameters: { encodings: [{ ssrc: 999 }], codecs: [{ payloadType: 111, mimeType: "audio/opus" }] }, producerId }; } }; return t; };
const router = { createPlainTransport: async () => fakeTransport(), canConsume: () => true, rtpCapabilities: {} };
const peer = (userId) => ({ callId: "call1", userId, transports: new Map(), producers: new Map(), consumers: new Map() });
test("caller + callee: create/connect/produce/consume gives each side the other's audio", async () => {
  const a = peer("caller"), b = peer("callee"), peers = [a, b], targets = [];
  const rpc = (s, method, payload) => handlePlainRpc({ method, payload, s, router, peers, announcedAddress: "203.0.113.5", emitTarget: (t) => targets.push(t) });
  for (const [s, ssrc] of [[a, 111111], [b, 222222]]) {
    const c = await rpc(s, "plain:create");
    assert.equal(c.ip, "203.0.113.5"); assert.ok(c.port > 0); assert.equal(c.srtpParameters.keyBase64.length, 40);
    await rpc(s, "plain:connect", { srtpParameters: { cryptoSuite: "AES_CM_128_HMAC_SHA1_80", keyBase64: "K".repeat(40) } });
    await rpc(s, "plain:produce", { kind: "audio", ssrc, payloadType: 111 });
  }
  const ca = await rpc(a, "plain:consume"), cb = await rpc(b, "plain:consume");
  assert.equal(ca.consumers.length, 1); assert.equal(cb.consumers.length, 1); assert.equal(ca.consumers[0].payloadType, 111);
  assert.equal(targets.length, 2);
});
test("connect rejects a wrong SRTP suite", async () => {
  const s = peer("x"); await handlePlainRpc({ method: "plain:create", s, router, peers: [s] });
  await assert.rejects(handlePlainRpc({ method: "plain:connect", payload: { srtpParameters: { cryptoSuite: "AEAD_AES_256_GCM", keyBase64: "k" } }, s, router, peers: [s] }));
});
