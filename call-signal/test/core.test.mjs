import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createSignal, iceConfig } from "../src/core.mjs";

const rig = (opts = {}) => { const out = []; const pushes = []; let fire;
  const s = createSignal({ send: (u, m) => out.push([u, m]), push: (u, p) => pushes.push([u, p]), setTimer: (f) => { fire = f; return 1; }, clearTimer: () => {}, ...opts });
  return { s, out, pushes, timeout: () => fire() }; };

test("ring goes only to callee, never broadcast; offer/answer/ice only to peer", () => {
  const { s, out } = rig(); const { callId } = s.handle("a", { t: "call:new", to: "b" });
  assert.deepEqual(out.map(([u]) => u), ["b"]);
  s.handle("b", { t: "call:accept", callId }); s.handle("a", { t: "offer", callId, sdp: "x" }); s.handle("b", { t: "ice", callId, candidate: "c" });
  assert.deepEqual(out.slice(1).map(([u, m]) => [u, m.t]), [["a", "call:accepted"], ["b", "offer"], ["a", "ice"]]);
  assert.equal(s.handle("z", { t: "offer", callId }).ok, false, "outsider cannot inject");
});
test("busy check", () => { const { s, out } = rig(); s.handle("a", { t: "call:new", to: "b" });
  assert.equal(s.handle("c", { t: "call:new", to: "b" }).error, "busy"); assert.equal(out.at(-1)[1].t, "call:busy"); });
test("reject / timeout / hangup / disconnect clean up, next call works", () => {
  for (const finish of ["reject", "timeout", "hangup", "disconnect"]) {
    const r = rig(); const { callId } = r.s.handle("a", { t: "call:new", to: "b" });
    if (finish === "reject") r.s.handle("b", { t: "call:reject", callId });
    if (finish === "timeout") r.timeout();
    if (finish === "hangup") { r.s.handle("b", { t: "call:accept", callId }); r.s.handle("a", { t: "call:leave", callId }); }
    if (finish === "disconnect") r.s.disconnected("b");
    assert.equal(r.s.calls.size, 0, finish); assert.equal(r.s.byUser.size, 0, finish);
    assert.equal(r.s.handle("a", { t: "call:new", to: "b" }).ok, true, `${finish}: clean next call`);
  }
});
test("push only when callee offline; TTL covers ring", () => { const r = rig({ online: () => false }); r.s.handle("a", { t: "call:new", to: "b" });
  assert.equal(r.pushes.length, 1); assert.ok(r.pushes[0][1].ttlSec >= 30); });
test("ICE: short-lived HMAC creds, order UDP -> TCP -> TLS 443, ChatSwap policy", () => {
  const c = iceConfig({ secret: "s", userId: "u1", now: 1_000_000 });
  assert.deepEqual(c.iceServers.slice(1).map((x) => x.urls[0]), ["turn:turn.openlounge.app:3478?transport=udp", "turn:turn.openlounge.app:3478?transport=tcp", "turns:turn.openlounge.app:443?transport=tcp"]);
  const u = c.iceServers[1].username; assert.equal(u, "1600:u1");
  assert.equal(c.iceServers[1].credential, crypto.createHmac("sha1", "s").update(u).digest("base64"));
  assert.deepEqual(c.policy, { sdpSemantics: "unified-plan", bundlePolicy: "max-bundle", rtcpMuxPolicy: "require", iceTransportPolicy: "relay", continualGathering: true });
});
test("phone-to-phone relay-only; SFU leg not relay-forced; sfu:plain goes to gateway only", () => {
  assert.equal(iceConfig({ secret: "s", userId: "u", mode: "sfu" }).policy.iceTransportPolicy, "all");
  const got = []; const r = rig({ sfu: (x) => got.push(x) }); const { callId } = r.s.handle("a", { t: "call:new", to: "b", route: "sfu" });
  assert.equal(r.out[0][1].route, "sfu"); r.s.handle("b", { t: "call:accept", callId });
  const n = r.out.length; assert.equal(r.s.handle("a", { t: "sfu:plain", callId, sdp: "v=0" }).ok, true);
  assert.equal(r.out.length, n, "not relayed to peer"); assert.deepEqual(got, [{ callId, userId: "a", sdp: "v=0" }]);
});

test("offline callee: push once, re-ring + delivered on connect", () => {
  const sent = [], pushes = []; let on = false;
  const s = createSignal({ send: (u, m) => sent.push([u, m]), push: (u, p) => pushes.push([u, p]), online: () => on, setTimer: () => 0, clearTimer: () => {} });
  const r = s.handle("a", { t: "call:new", to: "b", kind: "audio" });
  assert.equal(pushes.length, 1); assert.equal(pushes[0][1].callId, r.callId);
  on = true; assert.equal(s.connected("b"), r.callId);
  assert.ok(sent.filter(([u, m]) => u === "b" && m.t === "call:incoming").length >= 2);
  assert.equal(s.connected("a"), null);
});
