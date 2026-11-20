// t6111u: every link is live with camera + mic ON (join screen, creator auto-join, quiet rejoin); mute / camera toggles
// turn them off; a denied / missing camera degrades to camera off (avatar tile) and the call goes on with audio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CallEngine } from "../../src/lib/calls/engine";

const LINK = { id: "L1", callerId: "u_a", calleeId: "u_b", phase: "calling", video: false, link: { expiresAt: 0 }, caller: { name: "Sam" }, callee: { name: "Jordan" } };
const MEDIA = { url: "wss://x", token: "t" };

function engine(cam: "ok" | "denied" = "ok") {
  const e = new CallEngine() as any;
  e.meId = "u_b";
  e.socket = { on() {}, off() {}, request: (ev: string) => Promise.resolve(ev === "call:get" ? { ok: true, call: LINK } : { ok: true, call: LINK, media: MEDIA }) };
  e.netLog = () => {};
  e.diag = () => {};
  e.connect = async () => {};
  e.ensureCamPreview = async () => {
    if (cam === "ok") return (e.set({ camOn: true }), {});
    e.set({ camOn: false, error: "Camera unavailable. Continuing with audio." });
    return null;
  };
  return e;
}

test("link join screen opens with camera + mic on; Join publishes both", async () => {
  const e = engine();
  await e.openFromLink("L1", false);
  assert.equal(e.s.ui, "prejoin");
  assert.equal(e.s.camOn, true);
  assert.equal(e.s.muted, false);
  await e.joinFromPrejoin();
  assert.equal(e.s.ui, "connecting");
  assert.equal(e.s.camOn, true);
  assert.equal(e.s.muted, false);
});

test("link join screen toggles still turn camera / mic off before Join", async () => {
  const e = engine();
  await e.openFromLink("L1", false);
  await e.prejoinCam();
  e.prejoinMute();
  await e.joinFromPrejoin();
  assert.equal(e.s.camOn, false);
  assert.equal(e.s.muted, true);
});

test("creator auto-join and in-room rejoin are camera + mic on", async () => {
  const e = engine();
  assert.equal(await e.joinCreatedLink(LINK), true);
  assert.equal(e.s.camOn, true);
  assert.equal(e.s.muted, false);
});

test("camera denied on the join screen: camera off (avatar tile), audio join still works", async () => {
  const e = engine("denied");
  await e.openFromLink("L1", false);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(e.s.camOn, false);
  assert.equal(await e.joinFromPrejoin(), true);
  assert.equal(e.s.ui, "connecting");
  assert.equal(e.s.camOn, false);
});

test("browser camera opens once: the join's early open and connect() share one getUserMedia", async () => {
  const e = new CallEngine() as any;
  let opens = 0;
  e.openCam = () => { opens++; return new Promise((r) => setTimeout(() => { e.camTrack = { id: "t" }; r(e.camTrack); }, 20)); };
  const [t1, t2] = await Promise.all([e.ensureCamPreview(), e.ensureCamPreview()]);
  assert.equal(opens, 1);
  assert.equal(t1, t2);
  assert.equal(await e.ensureCamPreview(), t1);
  assert.equal(opens, 1);
});
