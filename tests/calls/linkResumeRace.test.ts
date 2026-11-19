// Donny's video (Nov 19 2026): tapping a call link on a cold page ran openFromLink and CallProvider's resume() at once.
// resume's call:current answered "no call" (sent before call:join registered the link) and ended the freshly joined
// call: native media was up, the page said "Call ended". A "no call" answer may only end the call the page asked about.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CallEngine } from "../../src/lib/calls/engine";

const LINK = { id: "L1", callerId: "u_a", calleeId: "u_b", phase: "calling", video: false, link: { expiresAt: Date.now() + 600_000 }, caller: { name: "Donny" }, callee: { name: "Keiko" } };

function engine(onRequest: (ev: string) => Promise<unknown>) {
  const e = new CallEngine() as any;
  e.meId = "u_a";
  e.socket = { on() {}, off() {}, request: (ev: string) => onRequest(ev) };
  e.netLog = () => {};
  e.diag = () => {};
  e.connect = async () => {};
  return e;
}

test("resume's stale 'no call' (asked before the link join) does not end the joined link call", async () => {
  let releaseCurrent!: (v: unknown) => void;
  const e = engine((ev) => {
    if (ev === "call:current") return new Promise((r) => (releaseCurrent = r));
    if (ev === "call:join") return Promise.resolve({ ok: true, call: LINK, media: { url: "wss://x", token: "t" } });
    return Promise.resolve({ ok: true });
  });
  const resumed = e.resume(); // page mount: asked with no call
  const joined = await e.joinLink(LINK);
  assert.equal(joined, true);
  releaseCurrent({ ok: true, call: null }); // the answer from before the join lands now
  await resumed;
  assert.notEqual(e.s.ui, "ended");
  assert.equal(e.s.call.id, "L1");
});

test("resume racing a link join still in flight does not end it", async () => {
  let releaseJoin!: (v: unknown) => void;
  const e = engine((ev) => {
    if (ev === "call:current") return Promise.resolve({ ok: true, call: null });
    if (ev === "call:join") return new Promise((r) => (releaseJoin = r));
    return Promise.resolve({ ok: true });
  });
  const joining = e.joinLink(LINK);
  await e.resume(); // asked while the join is in flight
  assert.equal(e.s.ui, "connecting");
  releaseJoin({ ok: true, call: LINK, media: { url: "wss://x", token: "t" } });
  assert.equal(await joining, true);
  assert.notEqual(e.s.ui, "ended");
});
