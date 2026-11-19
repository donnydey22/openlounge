// App-side call events -> olcall server (POST /v1/call-event). Pinned to the Go vector in olcall/server/events_test.go.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signOlcallEventToken, olcallEventUrl, forwardOlcallEvent } from "../../server/calls/olcallToken";

const secret = "olcall-public-test-vector-secret-0123456789";
const goVector = "eyJjYWxsSWQiOiJjYWxsLXZlY3Rvci0xIiwiZXZlbnQiOiJjYWxsOmFjY2VwdCIsImV4cCI6MTg5MzQ1NjAwMH0.zMPF6OGhws0CO3SmEs5AIH_h6BC5uvnI_XwjvNYDWmA";
const env = { OLCALL_URL: "wss://turn.openlounge.app/v1/call", OLCALL_TOKEN_SECRET: secret };

test("event token matches the Go signer byte-for-byte", () => {
  assert.equal(signOlcallEventToken(secret, { callId: "call-vector-1", event: "call:accept", exp: 1893456000 }), goVector);
  assert.throws(() => signOlcallEventToken(secret, { callId: "c", event: "call:bogus" as never, exp: 1 }));
  assert.throws(() => signOlcallEventToken("short", { callId: "c", event: "call:start", exp: 1 }));
});

test("event url derives from OLCALL_URL; unconfigured -> null", () => {
  assert.equal(olcallEventUrl(env), "https://turn.openlounge.app/v1/call-event");
  assert.equal(olcallEventUrl({ OLCALL_URL: "ws://127.0.0.1:8090/v1/call" }), "http://127.0.0.1:8090/v1/call-event");
  assert.equal(olcallEventUrl({}), null);
});

test("forward posts one signed token and returns the status", async () => {
  const seen: { url: string; body: string }[] = [];
  const fake = (async (url: string, init: RequestInit) => { seen.push({ url, body: String(init.body) }); return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
  assert.deepEqual(await forwardOlcallEvent("call:accept", "call-vector-1", env, 1893456000_000 - 120_000, fake), { status: 200, legs: {} });
  assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0].body), { token: goVector });
});

test("never throws and never blocks: unreachable, unconfigured, 409 are just statuses", async () => {
  const boom = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  assert.deepEqual(await forwardOlcallEvent("call:start", "c1", env, Date.now(), boom), { status: 0, legs: {} });
  assert.deepEqual(await forwardOlcallEvent("call:start", "c1", {}, Date.now(), boom), { status: 0, legs: {} });
  const conflict = (async () => new Response("{}", { status: 409 })) as unknown as typeof fetch;
  assert.deepEqual(await forwardOlcallEvent("call:decline", "c1", env, Date.now(), conflict), { status: 409, legs: {} });
});

// ── CallService hook: the app tells the call server about start/accept/decline, and a failing hook never touches the call.
import { CallService } from "../../server/calls/service";
import type { CallMediaBackend } from "../../server/calls/mediaBackend";
const backend = (): CallMediaBackend => ({ provider: "p2p" as const, issue: async ({ callId, userId }) => ({ provider: "p2p" as const, url: "x", token: `${callId}-${userId}` }), close: () => {} });
type Hook = (e: string, id: string) => unknown;
function svc(hook: Hook, extra: { push?: unknown; emits?: string[] } = {}) {
  const peer = (id: string) => ({ id, name: id, color: "#000", photoUrl: null });
  const emitUser = (u: string, ev: string) => { extra.emits?.push(`${u}:${ev}`); };
  return new CallService({ emitUser, isConnected: () => true, isForeground: () => !extra.push, peer, policy: () => ({ ok: true }), inRoom: () => false,
    appendCallMessage: () => {}, selectMedia: backend, olcallEvent: hook as never, ...(extra.push ? { push: extra.push as never } : {}) });
}
/** what the Go call server returns for an applied call:start: caller Idle->Ringing, callee Idle->Ringing */
const ringing = (id: string) => ({ status: 200, legs: { caller: { callId: id, leg: "caller", state: "ringing", seq: 1 }, callee: { callId: id, leg: "callee", state: "ringing", seq: 1 } } });
const fsm = (seen: string[]): Hook => (e, id) => { seen.push(`${e}|${id}`); return Promise.resolve(e === "call:start" ? ringing(id) : { status: 200, legs: {} }); };

test("service fires call:start, call:accept, call:decline once each, in order", async () => {
  const seen: string[] = [];
  const s = svc(fsm(seen));
  try {
    const one = await s.start("a", "b", false, "ca"); assert.ok(one.ok); if (!one.ok) return;
    await s.accept(one.call.id, "b", "cb");
    await s.accept(one.call.id, "b", "cb"); // same-device re-accept: no second event
    s.hangup(one.call.id, "a");
    const two = await s.start("a", "b", false, "ca2"); assert.ok(two.ok); if (!two.ok) return;
    s.decline(two.call.id, "b");
    s.decline(two.call.id, "b"); // already ended: no second event
    assert.deepEqual(seen, [`call:start|${one.call.id}`, `call:accept|${one.call.id}`, `call:hangup|${one.call.id}`, `call:start|${two.call.id}`, `call:decline|${two.call.id}`]);
  } finally { s.dispose?.(); }
});

test("strict ring gate: the callee rings (socket + push) only after the call server's callee leg is Ringing", async () => {
  const order: string[] = []; const emits: string[] = [];
  const push = { incoming: (u: string) => order.push(`push:${u}`), cancel: () => {} };
  const hook: Hook = (e, id) => { order.push(e); return Promise.resolve(e === "call:start" ? ringing(id) : { status: 200, legs: {} }); };
  const s = svc(hook, { push, emits });
  try {
    const st = await s.start("a", "b", false, "ca"); assert.ok(st.ok);
    assert.deepEqual(order.slice(0, 2), ["call:start", "push:b"]);
    assert.ok(emits.includes("b:call:incoming"));
  } finally { s.dispose?.(); }
});

for (const [name, hook] of [
  ["unreachable (status 0)", () => Promise.resolve({ status: 0, legs: {} })],
  ["refused (409)", (_e: string, id: string) => Promise.resolve({ status: 409, legs: { callee: { callId: id, leg: "callee", state: "terminal", seq: 2 } } })],
  ["200 but callee not Ringing", (_e: string, id: string) => Promise.resolve({ status: 200, legs: { callee: { callId: id, leg: "callee", state: "idle", seq: 0 } } })],
  ["throwing hook", () => { throw new Error("call server down"); }],
  ["rejected promise", () => Promise.reject(new Error("down"))],
] as [string, Hook][]) {
  test(`strict ring gate: ${name} -> no ring anywhere, call ends Failed`, async () => {
    const pushed: string[] = []; const emits: string[] = []; const seen: string[] = [];
    const push = { incoming: (u: string) => pushed.push(u), repush: (u: string) => pushed.push(u), cancel: () => {} };
    const s = svc((e, id) => { seen.push(e); return e === "call:start" ? hook(e, id) : Promise.resolve({ status: 200, legs: {} }); }, { push, emits });
    try {
      const st = await s.start("a", "b", false, "ca");
      assert.equal(st.ok, false);
      if (!st.ok) { assert.equal(st.reason, "call_server_unavailable"); assert.equal(st.call?.outcome, "failed"); }
      assert.deepEqual(pushed, []);
      assert.ok(!emits.includes("b:call:incoming"));
      assert.deepEqual(seen, ["call:start", "call:end"]);
    } finally { s.dispose?.(); }
  });
}

test("strict ring gate: a call server that never answers is cut off at 3 s", async () => {
  const pushed: string[] = [];
  const s = svc(() => new Promise(() => {}), { push: { incoming: (u: string) => pushed.push(u), cancel: () => {} } });
  try {
    const t0 = Date.now(); const st = await s.start("a", "b", false, "ca");
    const took = Date.now() - t0;
    assert.equal(st.ok, false); assert.deepEqual(pushed, []);
    assert.ok(took >= 2900 && took < 4500, `took ${took} ms`);
  } finally { s.dispose?.(); }
});

import { olcallEventQueue } from "../../server/calls/olcallToken";
test("queue keeps per-call order even when the first send is slow, and a failure doesn't stall the next", async () => {
  const arrived: string[] = [];
  const send = async (e: string, id: string) => {
    if (e === "call:start") await new Promise((r) => setTimeout(r, 30));
    if (id === "bad" && e === "call:start") throw new Error("down");
    arrived.push(`${e}|${id}`); return 200;
  };
  const q = olcallEventQueue(send as never);
  const ps = [q("call:start", "c1"), q("call:accept", "c1"), q("call:start", "bad"), q("call:decline", "bad")];
  await Promise.all(ps);
  assert.deepEqual(arrived.filter((x) => x.endsWith("|c1")), ["call:start|c1", "call:accept|c1"]);
  assert.deepEqual(arrived.filter((x) => x.endsWith("|bad")), ["call:decline|bad"]);
});
