// t6085 empty-link rejoin flake: a cold /call/<id> page sent call:get on a socket that was replaced before it answered.
// openFromLink caught the rejection and reported "Call ended" (redirect to /messages, no call leg ever opened).
// A lost reply / not-signed-in reply must be retried while the connection comes back; a real answer is used at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CallEngine } from "../../src/lib/calls/engine";

const LINK = { id: "L1", callerId: "u_a", calleeId: "u_b", phase: "calling", video: false, link: { expiresAt: 0 }, caller: { name: "Sam" }, callee: { name: "Jordan" } };

function engine(onRequest: (ev: string) => Promise<unknown>) {
  const e = new CallEngine() as any;
  e.meId = "u_b";
  e.socket = { on() {}, off() {}, request: (ev: string) => onRequest(ev) };
  e.netLog = () => {};
  e.diag = () => {};
  e.connect = async () => {};
  return e;
}

test("openFromLink: call:get lost on a recycled socket is retried, then the link is joined", async () => {
  let gets = 0;
  const e = engine((ev) => {
    if (ev === "call:get") return ++gets === 1 ? Promise.reject(new Error("Not connected")) : gets === 2 ? Promise.resolve({ ok: false, error: "Not signed in" }) : Promise.resolve({ ok: true, call: LINK });
    if (ev === "call:join") return Promise.resolve({ ok: true, call: LINK, media: { url: "wss://x", token: "t" } });
    return Promise.resolve({ ok: true });
  });
  const r = await e.openFromLink("L1", false);
  assert.equal(gets, 3);
  assert.deepEqual(r, { peerId: "u_a", ended: false });
  // t6093u: a tapped link opens the join screen first; Join opens the leg
  assert.equal(e.s.ui, "prejoin");
  assert.equal(await e.joinFromPrejoin(), true);
  assert.equal(e.s.ui, "connecting");
});

test("link join screen: mic / camera choices carry into the join; Not now joins nothing", async () => {
  const joins: unknown[] = [];
  const e = engine((ev) => {
    if (ev === "call:get") return Promise.resolve({ ok: true, call: LINK });
    if (ev === "call:join") return (joins.push(ev), Promise.resolve({ ok: true, call: LINK, media: { url: "wss://x", token: "t" } }));
    return Promise.resolve({ ok: true });
  });
  await e.openFromLink("L1", false);
  assert.equal(e.s.ui, "prejoin");
  e.prejoinMute();
  assert.equal(e.s.muted, true);
  e.cancelPrejoin();
  assert.equal(e.s.ui, null);
  assert.equal(joins.length, 0);
  await e.openFromLink("L1", false);
  e.prejoinMute();
  await e.joinFromPrejoin();
  assert.equal(joins.length, 1);
  assert.equal(e.s.ui, "connecting");
  assert.equal(e.s.muted, true);
});

test("link tapped while already in that room rejoins at once (no join screen)", async () => {
  const e = engine((ev) => (ev === "call:get" ? Promise.resolve({ ok: true, call: LINK }) : Promise.resolve({ ok: true, call: LINK, media: { url: "wss://x", token: "t" } })));
  await e.openFromLink("L1", false);
  await e.joinFromPrejoin();
  e.roomPromise = Promise.resolve(null);
  const r = await e.openFromLink("L1", false);
  assert.equal(r.ended, false);
  assert.equal(e.s.ui, "connecting");
});

test("openFromLink: a real 'no such call' answer still ends at once (no retry)", async () => {
  let gets = 0;
  const e = engine((ev) => (ev === "call:get" ? (gets++, Promise.resolve({ ok: false, error: "No such call" })) : Promise.resolve({ ok: true })));
  const r = await e.openFromLink("L1", false);
  assert.equal(gets, 1);
  assert.equal(r.ended, true);
});
