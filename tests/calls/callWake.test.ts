// ol-call-wake (Nov 10 2026, Telegram-matched wake/ring): 2 s offer re-send while unconfirmed, delivery on (re)connect,
// one ~5 s push only when the callee has no socket, and the three separate timers with their own end reasons.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  CallService,
  CALL_RECEIVE_TIMEOUT_MS,
  CALL_RING_TIMEOUT_MS,
  CALL_CONNECT_TIMEOUT_MS,
  CALL_RESEND_MS,
  callRepushMs,
} from "../../server/calls/service";
import type { CallMediaBackend } from "../../server/calls/mediaBackend";

const backend: CallMediaBackend = { provider: "p2p", issue: async ({ callId, userId }) => ({ provider: "p2p", url: "x", token: `${callId}-${userId}` }), close: () => {} };

function svc(o: { connected?: boolean; foreground?: boolean } = {}) {
  const st = { connected: o.connected ?? true, foreground: o.foreground ?? false };
  const emits: { u: string; ev: string; data: { call?: { id: string; phase: string; expiresAt: number }; reason?: string; resend?: unknown } }[] = [];
  const pushes: string[] = [];
  const logs: { m: string; x?: Record<string, unknown> }[] = [];
  let now = 1_000_000;
  const s = new CallService({
    emitUser: (u: string, ev: string, data: never) => emits.push({ u, ev, data }),
    isConnected: (u: string) => (u === "b" ? st.connected : true),
    isForeground: () => st.foreground,
    connCount: (u: string) => (u === "b" ? (st.connected ? 1 : 0) : 1),
    peer: (id: string) => ({ id, name: id, color: "#000", photoUrl: null }),
    policy: () => ({ ok: true }),
    inRoom: () => false,
    appendCallMessage: () => {},
    selectMedia: () => backend,
    now: () => now,
    push: { incoming: () => pushes.push("incoming"), repush: () => pushes.push("repush"), cancel: () => pushes.push("cancel") },
    log: (m: string, x?: Record<string, unknown>) => logs.push({ m, x }),
  } as never);
  const tick = (t: TestContext, ms: number) => {
    now += ms;
    t.mock.timers.tick(ms);
  };
  const incoming = () => emits.filter((e) => e.u === "b" && e.ev === "call:incoming");
  const ended = () => emits.filter((e) => e.u === "a" && e.ev === "call:state" && e.data.call?.phase === "ended");
  return { s, st, emits, pushes, logs, tick, incoming, ended };
}

const timers = (t: TestContext) => t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

test("defaults match the Telegram study: 20 s receive, 90 s ring, 30 s connect, 2 s re-send, ~5 s repush", () => {
  assert.equal(CALL_RECEIVE_TIMEOUT_MS, 20_000);
  assert.equal(CALL_RING_TIMEOUT_MS, 90_000);
  assert.equal(CALL_CONNECT_TIMEOUT_MS, 30_000);
  assert.equal(CALL_RESEND_MS, 2_000);
  assert.equal(callRepushMs(), 5_000);
});

test("re-send: the offer goes out again every 2 s over the callee's sockets while unconfirmed", async (t) => {
  timers(t);
  const x = svc();
  const r = await x.s.start("a", "b", false);
  assert.ok(r.ok);
  assert.equal(x.incoming().length, 1);
  x.tick(t, CALL_RESEND_MS);
  x.tick(t, CALL_RESEND_MS);
  x.tick(t, CALL_RESEND_MS);
  assert.equal(x.incoming().length, 4);
  assert.deepEqual(x.incoming().slice(1).map((e) => e.data.resend), [1, 2, 3]);
  assert.ok(x.incoming().every((e) => e.data.call?.id === r.call!.id), "same call id every time (clients dedupe on it)");
  assert.ok(x.logs.some((l) => l.m === "call ring resend"));
});

test("re-send stops on confirmation (ack)", async (t) => {
  timers(t);
  const x = svc();
  const r = await x.s.start("a", "b", false);
  x.tick(t, CALL_RESEND_MS);
  x.s.ack(r.call!.id, "b");
  const n = x.incoming().length;
  x.tick(t, CALL_RESEND_MS * 5);
  assert.equal(x.incoming().length, n);
});

test("re-send stops on accept, decline and caller cancel", async (t) => {
  timers(t);
  for (const how of ["accept", "decline", "cancel"] as const) {
    const x = svc();
    const r = await x.s.start("a", "b", false);
    const id = r.call!.id;
    if (how === "accept") await x.s.accept(id, "b", "conn-b");
    else if (how === "decline") x.s.decline(id, "b");
    else x.s.hangup(id, "a");
    const n = x.incoming().length;
    x.tick(t, CALL_RESEND_MS * 5);
    assert.equal(x.incoming().length, n, how);
    x.s.dispose();
  }
});

test("re-send skips the emit when the callee has no socket at all", async (t) => {
  timers(t);
  const x = svc({ connected: false });
  await x.s.start("a", "b", false);
  x.tick(t, CALL_RESEND_MS * 2);
  assert.equal(x.incoming().length, 1);
});

test("deliver on (re)connect: a callee socket that authenticates mid-ring gets the offer at once; nothing otherwise", async (t) => {
  timers(t);
  const x = svc({ connected: false });
  const r = await x.s.start("a", "b", false);
  const got: { ev: string; data: { call: { id: string } } }[] = [];
  assert.equal(x.s.userConnected("b", (ev, data) => got.push({ ev, data: data as never })), true);
  assert.equal(got.length, 1);
  assert.equal(got[0].ev, "call:incoming");
  assert.equal(got[0].data.call.id, r.call!.id);
  assert.equal(x.s.userConnected("a", () => assert.fail("caller gets no offer")), false);
  x.s.hangup(r.call!.id, "a");
  assert.equal(x.s.userConnected("b", () => assert.fail("ended call is not delivered")), false);
});

test("one more push at ~5 s only if the callee still has no socket", async (t) => {
  timers(t);
  const x = svc({ connected: false });
  await x.s.start("a", "b", false);
  assert.deepEqual(x.pushes, ["incoming"]);
  x.tick(t, callRepushMs() + 1);
  assert.deepEqual(x.pushes, ["incoming", "repush"]);
  x.tick(t, 10_000);
  assert.deepEqual(x.pushes.filter((p) => p === "repush").length, 1, "exactly one more push");
});

test("no ~5 s push when the callee has a socket connected (the re-send reaches it), or once confirmed", async (t) => {
  timers(t);
  const x = svc({ connected: true });
  await x.s.start("a", "b", false);
  x.tick(t, callRepushMs() + 1);
  assert.deepEqual(x.pushes, ["incoming"]);
  assert.ok(x.logs.some((l) => l.m === "call repush skipped"));
  const y = svc({ connected: false });
  const r = await y.s.start("a", "b", false);
  y.s.ack(r.call!.id, "b");
  y.tick(t, callRepushMs() + 1);
  assert.deepEqual(y.pushes, ["incoming"]);
});

test("receive timer: 20 s with no confirmation → missed, reason no_ack", async (t) => {
  timers(t);
  const x = svc();
  const r = await x.s.start("a", "b", false);
  x.tick(t, CALL_RECEIVE_TIMEOUT_MS - 1);
  assert.equal(x.ended().length, 0);
  x.tick(t, 2);
  assert.equal(x.ended().length, 1);
  assert.equal(x.ended()[0].data.reason, "no_ack");
  assert.equal(x.s.peek(r.call!.id, "a")?.outcome, "missed");
});

test("ring timer: 90 s counted from confirmation (not from start) → missed, reason no_answer", async (t) => {
  timers(t);
  const x = svc();
  const r = await x.s.start("a", "b", false);
  x.tick(t, 15_000); // confirmed late, inside the receive window
  x.s.ack(r.call!.id, "b");
  assert.equal(x.s.peek(r.call!.id, "b")?.expiresAt, 1_000_000 + 15_000 + CALL_RING_TIMEOUT_MS, "expiresAt follows the confirmation");
  x.tick(t, CALL_RECEIVE_TIMEOUT_MS); // the receive timer no longer applies
  assert.equal(x.ended().length, 0);
  x.tick(t, CALL_RING_TIMEOUT_MS - CALL_RECEIVE_TIMEOUT_MS - 1);
  assert.equal(x.ended().length, 0);
  x.tick(t, 2);
  assert.equal(x.ended().length, 1);
  assert.equal(x.ended()[0].data.reason, "no_answer");
  assert.equal(x.s.peek(r.call!.id, "a")?.outcome, "missed");
});

test("connect timer: 30 s after answer with no first audio → failed, reason connect_timeout", async (t) => {
  timers(t);
  const x = svc();
  const r = await x.s.start("a", "b", false);
  x.s.ack(r.call!.id, "b");
  await x.s.accept(r.call!.id, "b", "conn-b");
  x.tick(t, CALL_CONNECT_TIMEOUT_MS - 1);
  assert.equal(x.ended().length, 0);
  x.tick(t, 2);
  assert.equal(x.ended().length, 1);
  assert.equal(x.ended()[0].data.reason, "connect_timeout");
  assert.equal(x.s.peek(r.call!.id, "a")?.outcome, "failed");
});

test("connect timer is cleared by first audio (call:metric) or an audio-levels report; ring timer by accept", async (t) => {
  timers(t);
  for (const via of ["metric", "levels"] as const) {
    const x = svc();
    const r = await x.s.start("a", "b", false);
    x.s.ack(r.call!.id, "b");
    await x.s.accept(r.call!.id, "b", "conn-b");
    x.tick(t, 2_000);
    if (via === "metric") x.s.metric(r.call!.id, "b", 2023);
    else x.s.qualitySample(r.call!.id, "a", { inKbps: 30, outKbps: 30 });
    x.tick(t, CALL_RING_TIMEOUT_MS + CALL_CONNECT_TIMEOUT_MS);
    assert.equal(x.ended().length, 0, via);
    assert.ok(x.logs.some((l) => l.m === "call connect confirmed"), via);
    x.s.dispose();
  }
});

test("each end logs its own line (receive / ring / connect timeout)", async (t) => {
  timers(t);
  const a = svc();
  await a.s.start("a", "b", false);
  a.tick(t, CALL_RECEIVE_TIMEOUT_MS + 1);
  assert.ok(a.logs.some((l) => l.m === "call receive timeout"));
  const b = svc();
  const rb = await b.s.start("a", "b", false);
  b.s.ack(rb.call!.id, "b");
  b.tick(t, CALL_RING_TIMEOUT_MS + 1);
  assert.ok(b.logs.some((l) => l.m === "call ring timeout"));
  const c = svc();
  const rc = await c.s.start("a", "b", false);
  c.s.ack(rc.call!.id, "b");
  await c.s.accept(rc.call!.id, "b", "conn-b");
  c.tick(t, CALL_CONNECT_TIMEOUT_MS + 1);
  assert.ok(c.logs.some((l) => l.m === "call connect timeout"));
  assert.ok(c.logs.some((l) => l.m === "call end" && l.x?.reason === "connect_timeout"));
});

test("a repeated ack (dedupe) keeps the first confirmation time and does not re-arm the ring timer", async (t) => {
  timers(t);
  const x = svc();
  const r = await x.s.start("a", "b", false);
  x.s.ack(r.call!.id, "b");
  x.tick(t, 60_000);
  x.s.ack(r.call!.id, "b");
  x.tick(t, CALL_RING_TIMEOUT_MS - 60_000 + 1);
  assert.equal(x.ended().length, 1);
  assert.equal(x.ended()[0].data.reason, "no_answer");
});

test("call pushes have their own path: DM opt-out and the 30/h DM cap never block a ring; Android TTL 30 s", async () => {
  const { Notifier, CALL_PUSH_TTL_MS, DM_HOURLY_CAP } = await import("../../server/push/notifier");
  const sent: { tag: string; ttlMs?: number; sentAt?: string }[] = [];
  const n = new Notifier({
    repo: {
      getPrefs: async () => ({ dm: false }) as never, // DM pushes switched off
      tokensFor: async () => [{ token: "t".repeat(40), platform: "android" }] as never,
      removeToken: async () => {},
    } as never,
    sender: { name: "fake", send: async (_t: unknown, m: { tag: string; ttlMs?: number; data?: Record<string, string> }) => (sent.push({ tag: m.tag, ttlMs: m.ttlMs, sentAt: m.data?.sentAt }), { sent: 1, invalidTokens: [] }) } as never,
    isForeground: () => false,
    userName: () => "A",
    followerIds: () => [],
    followingIds: () => [],
  } as never);
  const call = { id: "c1", callerId: "a", video: false, expiresAt: Date.now() + 20_000, caller: { name: "A", photoUrl: null } };
  for (let i = 0; i < DM_HOURLY_CAP + 5; i++) assert.equal(await n.callIncoming("b", { ...call, id: `c${i}` }), "sent");
  assert.equal(sent.length, DM_HOURLY_CAP + 5);
  assert.equal(CALL_PUSH_TTL_MS, 30_000);
  assert.ok(sent.every((s) => s.ttlMs === 30_000 && /^\d+$/.test(s.sentAt ?? "")), "30 s TTL + server sentAt on every ring push");
  assert.equal(await n.dm({ fromId: "a", toId: "b", text: "hi", fromName: "A" }), "skip:pref", "DM pushes still honour the opt-out");
});

test("FCM sender: ttlMs sets the Android lifetime; other pushes keep 6 h", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../../server/push/sender.ts", import.meta.url), "utf8");
  assert.match(src, /ttl: msg\.ttlMs \?\? 6 \* 3600_000/);
});

test("web/iOS page engine: a repeated call:incoming for the ringing call re-acks and never restarts the ringtone; ringback only on Ringing", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  const onIncoming = src.slice(src.indexOf("private onIncoming"), src.indexOf("async accept("));
  const dup = onIncoming.slice(0, onIncoming.indexOf("if (this.busy) return;"));
  assert.match(dup, /this\.s\.call\?\.id === call\.id && this\.busy/);
  assert.match(dup, /call:ack/);
  assert.doesNotMatch(dup, /playRingtone/);
  const start = src.slice(src.indexOf("async start(peer"), src.indexOf("// ---------- incoming ----------"));
  assert.doesNotMatch(start.slice(0, start.indexOf("startWhenConnected")), /playRingback\(/, "no ringback from the tap (Calling… is silent)");
  assert.match(start, /r\.call\.phase === "ringing" && ringing\(\) !== "outgoing"/);
  assert.match(src, /call\.phase === "ringing" && role === "caller" && this\.s\.ui === "outgoing"[\s\S]{0,120}playRingback/);
});
