// Call links (Donny, Nov 18 2026): no waiting room, no host approval, no ring. The server mints the call and registers it
// with the call server (call:link, ten-minute LinkJoinTimeout); each person joins by tapping the link, straight to
// Connecting; the join token expires with the link; an unjoined link ends as expired after ten minutes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CallService, CALL_LINK_TTL_MS } from "../../server/calls/service";
import { olcallMediaFor, signOlcallToken } from "../../server/calls/olcallToken";
import type { CallMediaBackend } from "../../server/calls/mediaBackend";

const backend = (): CallMediaBackend => ({ provider: "p2p" as const, issue: async ({ callId, userId }) => ({ provider: "p2p" as const, url: "x", token: `${callId}-${userId}` }), close: () => {} });
function svc(o: { hook?: (e: string, id: string) => unknown; clock?: { t: number }; emits?: string[]; pushed?: string[]; msgs?: unknown[] } = {}) {
  const peer = (id: string) => ({ id, name: id, color: "#000", photoUrl: null });
  const idle = (id: string) => ({ status: 200, legs: { caller: { callId: id, leg: "caller", state: "idle", seq: 0 }, callee: { callId: id, leg: "callee", state: "idle", seq: 0 } } });
  return new CallService({
    emitUser: (u: string, ev: string) => { o.emits?.push(`${u}:${ev}`); }, isConnected: () => false, isForeground: () => true, peer,
    policy: () => ({ ok: true }), inRoom: () => false, appendCallMessage: (m: unknown) => { o.msgs?.push(m); }, selectMedia: backend,
    olcallEvent: (o.hook ?? ((e: string, id: string) => Promise.resolve(e === "call:link" ? idle(id) : { status: 200, legs: {} }))) as never,
    push: { incoming: (u: string) => o.pushed?.push(u), repush: (u: string) => o.pushed?.push(u), cancel: () => {} } as never,
    ...(o.clock ? { now: () => o.clock!.t } : {}),
  });
}

test("create: call:link fired once, no ring, no push, no call:incoming, nobody busy, url /call/<id>", async () => {
  const seen: string[] = []; const emits: string[] = []; const pushed: string[] = [];
  const s = svc({ hook: (e, id) => { seen.push(e); return Promise.resolve({ status: 200, legs: { callee: { callId: id, leg: "callee", state: e === "call:start" ? "ringing" : "idle", seq: 0 } } }); }, emits, pushed });
  try {
    const r = await s.createLink("a", "b"); assert.ok(r.ok); if (!r.ok) return;
    assert.deepEqual(seen, ["call:link"]);
    assert.equal(r.url, `https://openlounge.app/call/${r.call.id}`);
    assert.equal(r.call.link, true);
    assert.equal(r.call.expiresAt, r.call.createdAt + CALL_LINK_TTL_MS);
    assert.deepEqual(pushed, []); assert.deepEqual(emits, []); // nothing rang, nothing emitted
    assert.equal(s.isBusy("a"), false); assert.equal(s.isBusy("b"), false);
    // a normal call to either of them still goes through while the link sits unjoined
    const n = await s.start("c", "b", false, "cc"); assert.ok(n.ok);
    assert.deepEqual(seen, ["call:link", "call:start"]); assert.equal(s.isBusy("b"), true); // the normal call went through
  } finally { s.dispose?.(); }
});

for (const [name, hook] of [
  ["unreachable", () => Promise.resolve({ status: 0, legs: {} })],
  ["409", () => Promise.resolve({ status: 409, legs: {} })],
  ["throws", () => { throw new Error("down"); }],
] as [string, () => unknown][]) {
  test(`create fails closed when the call server does not accept call:link (${name})`, async () => {
    const msgs: unknown[] = [];
    const s = svc({ hook, msgs });
    try {
      const r = await s.createLink("a", "b");
      assert.equal(r.ok, false);
      assert.deepEqual(msgs, []); // no history line for a link that never existed
      assert.equal(s.isBusy("a"), false);
    } finally { s.dispose?.(); }
  });
}

test("join: the tap is the consent; nobody gets media before joining; both joined -> active", async () => {
  const s = svc();
  try {
    const r = await s.createLink("a", "b"); assert.ok(r.ok); if (!r.ok) return;
    const before = await s.get_(r.call.id, "b"); assert.ok(before.ok); assert.equal(before.ok && before.media, null);
    const creatorBefore = await s.get_(r.call.id, "a"); assert.equal(creatorBefore.ok && creatorBefore.media, null);
    const jb = await s.joinLink(r.call.id, "b", "cb", "android"); assert.ok(jb.ok);
    assert.ok(jb.ok && jb.media); assert.equal(jb.ok && jb.call.phase, "calling");
    assert.equal(s.isBusy("b"), true); assert.equal(s.isBusy("a"), false);
    const ja = await s.joinLink(r.call.id, "a", "ca", "ios"); assert.ok(ja.ok && ja.media);
    assert.equal(ja.ok && ja.call.phase, "active");
    assert.ok(ja.ok && ja.call.answeredAt);
    assert.equal(await s.joinLink(r.call.id, "z", "cz").then((x) => x.ok), false); // not a participant
  } finally { s.dispose?.(); }
});

test("join is refused for a ring call (no link) and for a busy user", async () => {
  const s = svc({ hook: (e, id) => Promise.resolve(e === "call:start" ? { status: 200, legs: { callee: { callId: id, leg: "callee", state: "ringing", seq: 1 } } } : { status: 200, legs: {} }) });
  try {
    const ring = await s.start("a", "b", false, "ca"); assert.ok(ring.ok); if (!ring.ok) return;
    assert.equal((await s.joinLink(ring.call.id, "b", "cb")).ok, false);
    const l = await s.createLink("c", "a"); assert.ok(l.ok); if (!l.ok) return;
    const j = await s.joinLink(l.call.id, "a", "ca2");
    assert.equal(j.ok, false); assert.equal(!j.ok && j.reason, "self_busy");
  } finally { s.dispose?.(); }
});

test("an unjoined link survives the ring timeout and the caller-gone sweep, then expires at ten minutes", async () => {
  const clock = { t: 1_000_000 }; const msgs: Array<{ outcome: string }> = [];
  const s = svc({ clock, msgs: msgs as unknown[] });
  try {
    const r = await s.createLink("a", "b"); assert.ok(r.ok); if (!r.ok) return;
    await s.joinLink(r.call.id, "a", "ca");
    clock.t += 60_000; // past the 30 s ring timeout and the 15 s caller-gone window
    (s as unknown as { sweep(): void }).sweep();
    assert.equal(s.isBusy("a"), true); // busyReason does not heal it as a stale ring
    assert.equal((await s.get_(r.call.id, "a")).ok && (await s.get_(r.call.id, "a")).call?.phase, "calling");
    clock.t = r.call.createdAt + CALL_LINK_TTL_MS; // the link's deadline
    const late = await s.joinLink(r.call.id, "b", "cb");
    assert.equal(late.ok, false); assert.equal(!late.ok && late.reason, "expired");
    assert.deepEqual(msgs.map((m) => m.outcome), ["missed"]);
    assert.equal(s.isBusy("a"), false);
  } finally { s.dispose?.(); }
});

test("join token: a link call's olcall token expires with the link, not after 300 s; expired link mints nothing", () => {
  const env = { OLCALL_URL: "wss://turn.openlounge.app/v1/call", OLCALL_TOKEN_SECRET: "olcall-link-test-secret-0123456789abcdef" };
  const now = 1_900_000_000_000;
  const linkExpiresAt = now + 600_000;
  const call = { id: "link-1", callerId: "a", calleeId: "b", linkExpiresAt };
  const m = olcallMediaFor(call, "b", env, now)!;
  assert.equal(m.expiresAt, Math.floor(linkExpiresAt / 1000));
  assert.equal(m.token, signOlcallToken(env.OLCALL_TOKEN_SECRET, { callId: "link-1", userId: "b", role: "callee", exp: Math.floor(linkExpiresAt / 1000) }));
  // later in the window the token still ends at the link deadline
  assert.equal(olcallMediaFor(call, "a", env, now + 500_000)!.expiresAt, Math.floor(linkExpiresAt / 1000));
  assert.equal(olcallMediaFor(call, "a", env, linkExpiresAt), null);
  // ring calls unchanged
  assert.equal(olcallMediaFor({ id: "r", callerId: "a", calleeId: "b" }, "a", env, now)!.expiresAt, Math.floor(now / 1000) + 300);
});

test("rtcCall hands the link deadline to the token minter only until both have joined", async () => {
  const s = svc();
  try {
    const r = await s.createLink("a", "b"); assert.ok(r.ok); if (!r.ok) return;
    assert.equal(s.rtcCall(r.call.id)?.linkExpiresAt, r.call.expiresAt);
    await s.joinLink(r.call.id, "a", "ca"); await s.joinLink(r.call.id, "b", "cb");
    assert.equal(s.rtcCall(r.call.id)?.linkExpiresAt, undefined); // active: normal short tokens for rejoin
  } finally { s.dispose?.(); }
});

test("link calls are excluded from the 15 s caller-left cleanup (creator offline, half-joined)", async () => {
  const clock = { t: 1_000_000 };
  const msgs: unknown[] = [];
  const s = svc({ clock, msgs });
  try {
    const r = await s.createLink("a", "b"); assert.ok(r.ok); if (!r.ok) return;
    const j = await s.joinLink(r.call.id, "b"); assert.ok(j.ok);
    (s as unknown as { _sweep: () => void })._sweep();
    clock.t += 60_000; (s as unknown as { _sweep: () => void })._sweep();
    assert.deepEqual(msgs, []); // still open: the link's own ten-minute expiry ends it, not the caller-left cleanup
    assert.equal(s.isBusy("b"), true); // b is actually inside
    assert.equal(s.isBusy("a"), false); // a has not tapped: not busy
  } finally { s.dispose?.(); }
});
