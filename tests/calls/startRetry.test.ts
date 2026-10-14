// call:start survives a tap made while the socket is (re)connecting: retried on "Not connected" / "Not signed in" /
// no reply, until START_WAIT_MS; then "Couldn't start the call". Hanging up meanwhile stops quietly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CallEngine } from "../../src/lib/calls/engine";

type Reply = { ok: boolean; error?: string; call?: unknown } | Error;
function fakeSocket(replies: Reply[]) {
  const sent: string[] = [];
  return {
    sent,
    on() {},
    off() {},
    request(ev: string) {
      sent.push(ev);
      const r = replies.length > 1 ? replies.shift()! : replies[0];
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
  };
}
function engine(sock: ReturnType<typeof fakeSocket>) {
  const e = new CallEngine() as any;
  e.socket = sock;
  e.s = { ...e.s, ui: "outgoing" };
  e.netLog = () => {};
  return e;
}
const CALL = { id: "c1" };

test("socket not open, then session not resumed, then OK → one call, no error", async () => {
  const sock = fakeSocket([new Error("Not connected"), { ok: false, error: "Not signed in" }, { ok: true, call: CALL }]);
  const r = await engine(sock).startWhenConnected("u_b", true);
  assert.equal(r.ok, true);
  assert.equal(sock.sent.length, 3);
});

test("a real refusal (busy / not allowed) is returned at once, not retried", async () => {
  const sock = fakeSocket([{ ok: false, error: "You can call Bea once they message you" }]);
  const r = await engine(sock).startWhenConnected("u_b", false);
  assert.equal(r.ok, false);
  assert.match(r.error, /once they message/);
  assert.equal(sock.sent.length, 1);
});

test("never connects → \"Couldn't start the call\" after START_WAIT_MS", async () => {
  const prev = CallEngine.START_WAIT_MS;
  CallEngine.START_WAIT_MS = 700;
  try {
    const sock = fakeSocket([new Error("Not connected")]);
    const t0 = Date.now();
    const r = await engine(sock).startWhenConnected("u_b", false);
    assert.equal(r.ok, false);
    assert.equal(r.error, "Couldn't start the call");
    assert.ok(Date.now() - t0 >= 700 && Date.now() - t0 < 3000);
    assert.ok(sock.sent.length >= 2);
  } finally {
    CallEngine.START_WAIT_MS = prev;
  }
});

test("hang up while waiting → stops quietly (reason cancelled, no error toast)", async () => {
  const sock = fakeSocket([new Error("Not connected")]);
  const e = engine(sock);
  setTimeout(() => (e.s = { ...e.s, ui: null }), 300);
  const r = await e.startWhenConnected("u_b", false);
  assert.equal(r.reason, "cancelled");
  assert.equal(r.error, undefined);
});
