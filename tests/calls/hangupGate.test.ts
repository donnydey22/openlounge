// Hang-up gate (Donny, Nov 19 2026): a person's hang-up ends the call only in Active (or as Cancel while the caller's
// ring is going). During Connecting the End button is disabled and stray / native lifecycle hang-ups are ignored and
// logged as hangup-blocked; failure paths (exhausted recovery, failed native connect) still end the call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CallEngine, CONNECTING_ESCAPE_MS } from "../../src/lib/calls/engine";

function engine(ui: string) {
  const e = new CallEngine() as any;
  const emitted: { ev: string; source?: string }[] = [];
  const reqs: string[] = [];
  e.socket = { emit: (_n: string, d: { ev: string; source?: string }) => emitted.push(d), request: async (n: string) => { reqs.push(n); return { ok: true }; } };
  e.req = async (n: string) => { reqs.push(n); return { ok: true }; };
  e.netLog = () => {};
  e.teardownMedia = () => {};
  e.endWith = () => { e.s = { ...e.s, ui: "ended" }; };
  e.set({ call: { id: "c1", callerId: "a", calleeId: "b", caller: { name: "a" }, callee: { name: "b" } }, role: "caller", ui });
  return { e, emitted, reqs };
}

test("Connecting: End button and native hang-up are blocked and logged; call stays", async () => {
  for (const source of ["button", "native"] as const) {
    const { e, emitted, reqs } = engine("connecting");
    assert.equal(e.hangupAllowed(), false);
    await e.hangup(source);
    assert.equal(e.snapshot().ui, "connecting");
    assert.deepEqual(reqs, []);
    assert.deepEqual(emitted.map((d) => [d.ev, d.source]), [["hangup-blocked", source]]);
  }
});

test("Active: End hangs up and the source is logged", async () => {
  const { e, emitted, reqs } = engine("active");
  assert.equal(e.hangupAllowed(), true);
  await e.hangup("button");
  assert.equal(e.snapshot().ui, "ended");
  assert.deepEqual(reqs, ["call:hangup"]);
  assert.equal(emitted[0].ev, "hangup"); assert.equal(emitted[0].source, "button");
});

test("Outgoing ring: Cancel still works", async () => {
  const { e, reqs } = engine("outgoing");
  await e.hangup("button");
  assert.deepEqual(reqs, ["call:hangup"]);
});

test("Connecting failure paths still end the call", async () => {
  const { e, reqs } = engine("connecting");
  await e.hangup("failure");
  assert.deepEqual(reqs, ["call:hangup"]);
});

test("Connecting stalled past the escape window: End comes back", () => {
  const { e } = engine("connecting");
  assert.equal(e.hangupAllowed(Date.now() + CONNECTING_ESCAPE_MS - 1), false);
  assert.equal(e.hangupAllowed(Date.now() + CONNECTING_ESCAPE_MS + 1), true);
});
