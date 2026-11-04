import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { audioRtp, watchTwoWay } from "../../src/lib/calls/twoWayRtp";
const m = (o: Record<string, unknown>[]) => new Map(o.map((s, i) => [String(i), s]));
describe("two-way RTP gate (every session shape)", () => {
  it("reads WebRTC, WASM and PJSIP counters", () => {
    assert.deepEqual(audioRtp([m([{ type: "inbound-rtp", kind: "audio", packetsReceived: 5 }, { type: "outbound-rtp", kind: "audio", packetsSent: 7 }, { type: "inbound-rtp", kind: "video", packetsReceived: 99 }])]), { rx: 5, tx: 7 });
    assert.deepEqual(audioRtp([m([{ type: "wasm-call", packetsReceived: 3, packetsSent: 4 }])]), { rx: 3, tx: 4 });
    assert.deepEqual(audioRtp([m([{ type: "pjsip", rxPkt: 2, txPkt: 9 }])]), { rx: 2, tx: 9 });
  });
  for (const pair of ["ios>android", "android>ios", "ios>ios", "android>android", "web>ios", "ios>web", "web>android", "android>web", "web>web"])
    it(`${pair}: stays connecting while one side is silent, connects once both flow`, async () => {
      let rx = 0, tx = 0, flowing = false;
      const shape = pair.includes("ios") ? (r: number, t: number) => m([{ type: "pjsip", rxPkt: r, txPkt: t }]) : (r: number, t: number) => m([{ type: "inbound-rtp", kind: "audio", packetsReceived: r }, { type: "outbound-rtp", kind: "audio", packetsSent: t }]);
      const w = watchTwoWay(async () => [shape(rx, tx)], () => (flowing = true), () => {}, 20);
      const send = setInterval(() => (tx += 5), 10); // we send; peer silent (late producer)
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(flowing, false);
      const recv = setInterval(() => (rx += 5), 10);
      await new Promise((r) => setTimeout(r, 200));
      clearInterval(send); clearInterval(recv); w.stop();
      assert.equal(flowing, true);
    });
});
