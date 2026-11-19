// Call links (Donny, Nov 18 2026): no waiting room, no host approval, no ring. The server mints the call and registers it
// with the call server (call:link); each person joins by tapping the link, straight to Connecting.
// Nov 19 2026 (Donny t6066u): links are always alive: no expiry, no sweep, a leaver drops only themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CallService } from "../../server/calls/service";
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
    assert.equal(r.call.expiresAt, 0); // no deadline: links never expire
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

test("links are always alive (t6066u): no ring timeout, no caller-gone sweep, no ten-minute expiry", async () => {
  const clock = { t: 1_000_000 }; const msgs: Array<{ outcome: string }> = [];
  const s = svc({ clock, msgs: msgs as unknown[] });
  try {
    const r = await s.createLink("a", "b"); assert.ok(r.ok); if (!r.ok) return;
    await s.joinLink(r.call.id, "a", "ca");
    clock.t += 60_000; // past the 30 s ring timeout and the 15 s caller-gone window
    (s as unknown as { sweep(): void }).sweep();
    assert.equal(s.isBusy("a"), true); // busyReason does not heal it as a stale ring
    assert.equal((await s.get_(r.call.id, "a")).ok && (await s.get_(r.call.id, "a")).call?.phase, "calling");
    clock.t = r.call.createdAt + 6_000_000; // far past the old ten-minute deadline
    (s as unknown as { sweep(): void }).sweep();
    const late = await s.joinLink(r.call.id, "b", "cb");
    assert.ok(late.ok && late.media); assert.equal(late.ok && late.call.phase, "active");
    clock.t += 24 * 3_600_000; (s as unknown as { sweep(): void }).sweep(); // a day in the room, both offline: still alive
    assert.deepEqual(msgs, []);
    assert.equal((await s.get_(r.call.id, "a")).ok && (await s.get_(r.call.id, "a")).call?.phase, "active");
  } finally { s.dispose?.(); }
});

test("a link leaver drops only themselves; the link stays joinable, even empty (t6066u)", async () => {
  const seen: string[] = []; const msgs: unknown[] = [];
  const idle = (id: string) => ({ status: 200, legs: { caller: { callId: id, leg: "caller", state: "idle", seq: 0 }, callee: { callId: id, leg: "callee", state: "idle", seq: 0 } } });
  const s = svc({ hook: (e, id) => { seen.push(e); return Promise.resolve(e === "call:link" ? idle(id) : { status: 200, legs: {} }); }, msgs });
  try {
    const r = await s.createLink("a", "b"); assert.ok(r.ok); if (!r.ok) return;
    await s.joinLink(r.call.id, "a", "ca"); await s.joinLink(r.call.id, "b", "cb");
    assert.deepEqual(s.room(r.call.id, "a"), { ok: true, here: ["a", "b"] });
    const h = s.hangup(r.call.id, "b"); assert.ok(h.ok); assert.equal(h.ok && h.call.phase, "active");
    assert.equal(s.isBusy("b"), false); assert.equal(s.isBusy("a"), true);
    assert.deepEqual(s.room(r.call.id, "a"), { ok: true, here: ["a"] });
    s.hangup(r.call.id, "a"); // everyone left
    assert.deepEqual(s.room(r.call.id, "a"), { ok: true, here: [] });
    assert.deepEqual(msgs, []); // nothing ended
    assert.ok(!seen.includes("call:hangup") && !seen.includes("call:end")); // the call server is never told to end it
    const back = await s.joinLink(r.call.id, "b", "cb2"); assert.ok(back.ok && back.media); // empty link rejoined
    assert.equal(seen.filter((e) => e === "call:link").length, 4); // created + re-registered on every tap
  } finally { s.dispose?.(); }
});

test("join token: link joins get the normal short per-join token (no link deadline exists)", () => {
  const env = { OLCALL_URL: "wss://turn.openlounge.app/v1/call", OLCALL_TOKEN_SECRET: "olcall-link-test-secret-0123456789abcdef" };
  const now = 1_900_000_000_000;
  const m = olcallMediaFor({ id: "link-1", callerId: "a", calleeId: "b" }, "b", env, now)!;
  assert.equal(m.expiresAt, Math.floor(now / 1000) + 300);
  assert.equal(m.token, signOlcallToken(env.OLCALL_TOKEN_SECRET, { callId: "link-1", userId: "b", role: "callee", exp: Math.floor(now / 1000) + 300 }));
  // a year later the same link still mints a fresh join token
  assert.ok(olcallMediaFor({ id: "link-1", callerId: "a", calleeId: "b" }, "a", env, now + 365 * 86_400_000));
});

test("rtcCall never hands a link deadline to the token minter (links never expire; normal per-join tokens)", async () => {
  const s = svc();
  try {
    const r = await s.createLink("a", "b"); assert.ok(r.ok); if (!r.ok) return;
    assert.equal((s.rtcCall(r.call.id) as Record<string, unknown> | null)?.linkExpiresAt, undefined);
    await s.joinLink(r.call.id, "a", "ca"); await s.joinLink(r.call.id, "b", "cb");
    assert.equal((s.rtcCall(r.call.id) as Record<string, unknown> | null)?.linkExpiresAt, undefined);
  } finally { s.dispose?.(); }
});

test("link calls are excluded from the 15 s caller-left cleanup (creator offline, half-joined)", async () => {
  const clock = { t: 1_000_000 };
  const msgs: unknown[] = [];
  const s = svc({ clock, msgs });
  try {
    const r = await s.createLink("a", "b"); assert.ok(r.ok); if (!r.ok) return;
    const j = await s.joinLink(r.call.id, "b", "cb"); assert.ok(j.ok);
    (s as unknown as { _sweep: () => void })._sweep();
    clock.t += 60_000; (s as unknown as { _sweep: () => void })._sweep();
    assert.deepEqual(msgs, []); // still open: links are always alive (t6066u)
    assert.equal(s.isBusy("b"), true); // b is actually inside
    assert.equal(s.isBusy("a"), false); // a has not tapped: not busy
  } finally { s.dispose?.(); }
});
