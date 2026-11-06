import test from "node:test";
import assert from "node:assert/strict";
import { CallSession } from "../../src/lib/calls/rtc/CallSession";
import { RtcSessionHub } from "../../server/calls/rtcSession";
import { rtcIceConfig, p2pMedia } from "../../server/calls/rtcIceConfig";
import { CallFailure, fromMediaError, mayRecoverOverNetwork, fromIceState } from "../../src/lib/calls/rtc/CallFailures";

const mk = (phase = "active") => {
  const sent: Array<[string, string, any]> = [];
  const hub = new RtcSessionHub({ call: (id) => (id === "c1" ? { callerId: "a", calleeId: "b", phase } : null), emitUser: (u, ev, d) => sent.push([u, ev, d]) });
  return { hub, sent };
};

test("relays offer to peer with from", () => {
  const { hub, sent } = mk();
  assert.deepEqual(hub.signal("a", { callId: "c1", gen: 0, seq: 0, kind: "offer", sdp: "v=0" }), { ok: true });
  assert.equal(sent[0][0], "b");
  assert.equal(sent[0][2].from, "caller");
});
test("auth, phase, replay, generation", () => {
  const { hub } = mk();
  assert.deepEqual(hub.signal("z", { callId: "c1", gen: 0, seq: 0, kind: "ready" }), { ok: false, error: "not_participant" });
  assert.deepEqual(hub.signal("a", { callId: "nope", gen: 0, seq: 0, kind: "ready" }), { ok: false, error: "unknown_call" });
  hub.signal("a", { callId: "c1", gen: 0, seq: 5, kind: "ready" });
  assert.deepEqual(hub.signal("a", { callId: "c1", gen: 0, seq: 5, kind: "ready" }), { ok: false, error: "replayed" });
  assert.deepEqual(hub.signal("a", { callId: "c1", gen: 1, seq: 0, kind: "ready" }), { ok: true });
  assert.deepEqual(hub.signal("b", { callId: "c1", gen: 0, seq: 9, kind: "ready" }), { ok: false, error: "stale_generation" });
  assert.deepEqual(hub.signal("a", { callId: "c1", gen: 1, seq: 1, kind: "offer" }), { ok: false, error: "bad_request" });
  assert.deepEqual(mk("ringing").hub.signal("a", { callId: "c1", gen: 0, seq: 0, kind: "offer", sdp: "x" }), { ok: false, error: "not_active" });
});
test("ice config: short-lived OL TURN, no secret leak", () => {
  const c = rtcIceConfig("c1", "a", { secret: "s3cret", now: () => 1_000_000 });
  assert.equal(c.expiresAt, 1000 + 600);
  assert.ok(JSON.stringify(c).includes("turn.openlounge.app"));
  assert.ok(!JSON.stringify(c).includes("s3cret"));
  assert.equal(p2pMedia("c1", "a", 3600).provider, "p2p");
});
test("local failures never recover over network", () => {
  for (const n of ["NotAllowedError", "NotFoundError", "NotReadableError", "NotSupportedError"]) assert.equal(mayRecoverOverNetwork(fromMediaError({ name: n })), false);
  assert.equal(fromIceState("connected"), null);
  assert.equal(mayRecoverOverNetwork(fromIceState("failed") as CallFailure), true);
});

test("TURN lease maintenance is bounded and its timer is cancelled on call close", (t) => {
  t.mock.timers.enable({apis:["setTimeout"]});
  let renewals=0;
  const sock={on(){},off(){},request:async<T>()=>({ok:true} as T)};
  const call=new CallSession(sock,{callId:"lease",role:"caller",media:{provider:"p2p",url:"rtc",token:""},log:ev=>{if(ev==="turn-lease-renew")renewals++}});
  try{
    // White-box scheduler test; real same-PC/RTP behavior is covered by the browser matrix.
    (call as any).scheduleTurnLease();
    t.mock.timers.tick(479_999);assert.equal(renewals,0);
    t.mock.timers.tick(1);assert.equal(renewals,1);
    call.close();assert.equal((call as any).turnLeaseTimer,null);
    t.mock.timers.tick(960_000);assert.equal(renewals,1);
  }finally{call.close();t.mock.timers.reset()}
});
