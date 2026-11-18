// App-side call events -> olcall server (POST /v1/call-event). Pinned to the Go vector in olcall/server/events_test.go.
import { test } from "node:test";
import assert from "node:assert/strict";
import { signOlcallEventToken, olcallEventUrl, forwardOlcallEvent } from "../../server/calls/olcallToken";

const secret = "olcall-public-test-vector-secret-0123456789";
const goVector = "eyJjYWxsSWQiOiJjYWxsLXZlY3Rvci0xIiwiZXZlbnQiOiJjYWxsOmFjY2VwdCIsImV4cCI6MTg5MzQ1NjAwMH0.zMPF6OGhws0CO3SmEs5AIH_h6BC5uvnI_XwjvNYDWmA";
const env = { OLCALL_URL: "wss://turn.openlounge.app/v1/call", OLCALL_TOKEN_SECRET: secret };

test("event token matches the Go signer byte-for-byte", () => {
  assert.equal(signOlcallEventToken(secret, { callId: "call-vector-1", event: "call:accept", exp: 1893456000 }), goVector);
  assert.throws(() => signOlcallEventToken(secret, { callId: "c", event: "call:hangup" as never, exp: 1 }));
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
  assert.equal(await forwardOlcallEvent("call:accept", "call-vector-1", env, 1893456000_000 - 120_000, fake), 200);
  assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(seen[0].body), { token: goVector });
});

test("never throws and never blocks: unreachable, unconfigured, 409 are just statuses", async () => {
  const boom = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  assert.equal(await forwardOlcallEvent("call:start", "c1", env, Date.now(), boom), 0);
  assert.equal(await forwardOlcallEvent("call:start", "c1", {}, Date.now(), boom), 0);
  const conflict = (async () => new Response("{}", { status: 409 })) as unknown as typeof fetch;
  assert.equal(await forwardOlcallEvent("call:decline", "c1", env, Date.now(), conflict), 409);
});

// ── CallService hook: the app tells the call server about start/accept/decline, and a failing hook never touches the call.
import { CallService } from "../../server/calls/service";
import type { CallMediaBackend } from "../../server/calls/mediaBackend";
const backend = (): CallMediaBackend => ({ provider: "p2p" as const, issue: async ({ callId, userId }) => ({ provider: "p2p" as const, url: "x", token: `${callId}-${userId}` }), close: () => {} });
function svc(hook: (e: string, id: string) => void) {
  const peer = (id: string) => ({ id, name: id, color: "#000", photoUrl: null });
  return new CallService({ emitUser: () => {}, isConnected: () => true, isForeground: () => true, peer, policy: () => ({ ok: true }), inRoom: () => false, appendCallMessage: () => {}, selectMedia: backend, olcallEvent: hook });
}

test("service fires call:start, call:accept, call:decline once each, in order", async () => {
  const seen: string[] = [];
  const s = svc((e, id) => seen.push(`${e}|${id}`));
  try {
    const one = await s.start("a", "b", false, "ca"); assert.ok(one.ok); if (!one.ok) return;
    await s.accept(one.call.id, "b", "cb");
    await s.accept(one.call.id, "b", "cb"); // same-device re-accept: no second event
    s.hangup(one.call.id, "a");
    const two = await s.start("a", "b", false, "ca2"); assert.ok(two.ok); if (!two.ok) return;
    s.decline(two.call.id, "b");
    s.decline(two.call.id, "b"); // already ended: no second event
    assert.deepEqual(seen, [`call:start|${one.call.id}`, `call:accept|${one.call.id}`, `call:start|${two.call.id}`, `call:decline|${two.call.id}`]);
  } finally { s.dispose?.(); }
});

test("a throwing hook never blocks or ends a call", async () => {
  const s = svc(() => { throw new Error("call server down"); });
  try {
    const st = await s.start("a", "b", false, "ca"); assert.ok(st.ok); if (!st.ok) return;
    const ac = await s.accept(st.call.id, "b", "cb");
    assert.ok(ac.ok);
    assert.equal((s as any).calls.get(st.call.id).phase, "active");
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
