// 1:1 calls: signaling state machine over real WebSocket clients against the app server (local Postgres only).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import "./env";
import { setTestEnv, startApp, wipeDb, phoneLogin, sql, wsClient, api, type App } from "../unified-auth/harness";

setTestEnv({ providers: false });
let app: App;
type L = Awaited<ReturnType<typeof phoneLogin>>;
let A: L, B: L, C: L, D: L;
const uniq = () => randomBytes(3).toString("hex");
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const id = (x: L) => x.res.user.id as string;
type Ev = { ev: string; data: any; at: number };
function inbox(ws: any) {
  const got: Ev[] = [];
  ws.on("message", (raw: Buffer) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "evt") got.push({ ev: m.ev, data: m.data, at: Date.now() });
  });
  return got;
}
async function waitFor<T>(fn: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out waiting");
    await sleep(20);
  }
}
const stateOf = (box: Ev[], callId: string, phase: string) => box.find((e) => e.ev === "call:state" && e.data.call.id === callId && e.data.call.phase === phase);
const callMsg = (box: Ev[], callId: string) => box.find((e) => e.ev === "dm:message" && e.data.kind === "call" && e.data.call?.id === callId)?.data;
const jwt = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
let inA: Ev[], inB: Ev[], inC: Ev[];

before(async () => {
  await wipeDb();
  app = await startApp();
  A = await phoneLogin(app.wsUrl, phone(), { firstName: "Donny", username: `donny_${uniq()}` });
  B = await phoneLogin(app.wsUrl, phone(), { firstName: "Bea", username: `bea_${uniq()}` });
  C = await phoneLogin(app.wsUrl, phone(), { firstName: "Cal", username: `cal_${uniq()}` });
  D = await phoneLogin(app.wsUrl, phone(), { firstName: "Dee", username: `dee_${uniq()}` });
  inA = inbox(A.client.ws);
  inB = inbox(B.client.ws);
  inC = inbox(C.client.ws);
});
after(async () => {
  for (const x of [A, B, C, D]) x?.client.close();
  await app?.close();
});

test("cold calls from strangers are refused; a reply or follow-back unlocks calling", async () => {
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_allowed");
  assert.match(r.error, /Bea/);
  // B messages A → A may call B; B follows C → C may call B
  assert.ok((await B.client.req("dm:send", { to: id(A), text: "hey, call me" })).ok);
  assert.ok((await B.client.req("user:follow", { userId: id(C), follow: true })).ok);
  assert.ok((await A.client.req("dm:send", { to: id(B), text: "ok" })).ok);
  assert.ok((await C.client.req("dm:send", { to: id(B), text: "yo" })).ok);
  const self = await A.client.req("call:start", { peerId: id(A) });
  assert.equal(self.reason, "self");
});

test("ring → ack → accept → hang up: tokens pre-minted at ring time, states fan out, service message with duration", async () => {
  const t0 = Date.now();
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.ok(r.ok, JSON.stringify(r));
  const call = r.call;
  assert.equal(call.phase, "calling");
  assert.equal(call.caller.name, "Donny");
  assert.equal(call.callee.name, "Bea");
  assert.ok(call.expiresAt - call.createdAt === 1500);
  // caller media ready before the callee even answers
  assert.equal(r.media.url, process.env.LIVEKIT_URL);
  assert.equal(jwt(r.media.token).video.room, `openlounge-call-${call.id}`);
  assert.equal(jwt(r.media.token).sub, id(A));
  // callee gets the ring with its own token already in hand
  const inc = await waitFor(() => inB.find((e) => e.ev === "call:incoming" && e.data.call.id === call.id));
  assert.equal(jwt(inc.data.media.token).sub, id(B));
  assert.equal(jwt(inc.data.media.token).video.canPublish, true);
  assert.ok(inc.at - t0 < 1000, "ring delivered fast");
  // B's device acks → A sees Ringing…
  assert.ok((await B.client.req("call:ack", { callId: call.id })).ok);
  await waitFor(() => stateOf(inA, call.id, "ringing"));
  // a stranger can't see or touch the call
  assert.equal((await C.client.req("call:get", { callId: call.id })).ok, false);
  assert.equal((await C.client.req("call:hangup", { callId: call.id })).ok, false);
  const acc = await B.client.req("call:accept", { callId: call.id });
  assert.ok(acc.ok);
  assert.equal(acc.call.phase, "active");
  assert.equal(jwt(acc.media.token).sub, id(B));
  await waitFor(() => stateOf(inA, call.id, "active"));
  // busy while in a call: D… needs a relationship first
  assert.ok((await A.client.req("user:follow", { userId: id(D), follow: true })).ok);
  const busy = await D.client.req("call:start", { peerId: id(A) });
  assert.equal(busy.ok, false);
  assert.equal(busy.reason, "busy");
  // upgrade to video is relayed
  assert.ok((await A.client.req("call:video", { callId: call.id, on: true })).ok);
  const v = await waitFor(() => inB.find((e) => e.ev === "call:video" && e.data.callId === call.id));
  assert.equal(v.data.on, true);
  assert.equal(v.data.from, id(A));
  // metric
  assert.ok((await B.client.req("call:metric", { callId: call.id, acceptToAudioMs: 640 })).ok);
  await sleep(1100);
  assert.ok((await B.client.req("call:hangup", { callId: call.id })).ok);
  const endA = await waitFor(() => stateOf(inA, call.id, "ended"));
  assert.equal(endA.data.call.outcome, "completed");
  assert.equal(endA.data.by, id(B));
  const m = await waitFor(() => callMsg(inB, call.id));
  assert.equal(m.fromId, id(A));
  assert.equal(m.call.outcome, "completed");
  assert.equal(m.call.video, true, "upgraded call is logged as a video call");
  assert.ok(m.call.durationSec >= 1);
  assert.ok(m.readAt, "answered calls are not unread");
  assert.match(m.text, /Video call · 0:0[1-9]/);
  // persisted
  await sleep(1500);
  const rows = await sql<any>(`SELECT kind, room_id, call FROM dms WHERE id = $1`, [m.id]);
  assert.equal(rows[0]?.kind, "call");
  assert.equal(rows[0]?.room_id, `call-${call.id}`);
  assert.equal(rows[0]?.call.outcome, "completed");
  // ended call is queryable for a while (deep link → "Call ended")
  const g = await A.client.req("call:get", { callId: call.id });
  assert.equal(g.call.phase, "ended");
  assert.equal(g.media, null);
  // D's busy attempt left A a missed call
  await waitFor(() => inA.find((e) => e.ev === "dm:message" && e.data.kind === "call" && e.data.call.outcome === "busy"));
});

test("decline with a quick reply: Declined message + the reply as a normal DM", async () => {
  const r = await A.client.req("call:start", { peerId: id(B), video: true });
  assert.ok(r.ok);
  assert.equal(r.call.video, true);
  await waitFor(() => inB.find((e) => e.ev === "call:incoming" && e.data.call.id === r.call.id));
  assert.ok((await B.client.req("call:decline", { callId: r.call.id, message: "Can't talk now, call you later" })).ok);
  const end = await waitFor(() => stateOf(inA, r.call.id, "ended"));
  assert.equal(end.data.call.outcome, "declined");
  const m = await waitFor(() => callMsg(inA, r.call.id));
  assert.match(m.text, /Declined video call/);
  await waitFor(() => inA.find((e) => e.ev === "dm:message" && e.data.fromId === id(B) && e.data.text === "Can't talk now, call you later"));
});

test("no answer for 45s (1.5s here) → missed: unread for the callee", async () => {
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.ok(r.ok);
  const end = await waitFor(() => stateOf(inB, r.call.id, "ended"), 4000);
  assert.equal(end.data.call.outcome, "missed");
  const m = await waitFor(() => callMsg(inB, r.call.id));
  assert.equal(m.readAt ?? null, null);
  assert.match(m.text, /Missed audio call/);
  const unread = [...inB].reverse().find((e) => e.ev === "dm:unread");
  assert.ok(unread && unread.data.count >= 1);
});

test("caller cancels before answer → cancelled (shown to the callee as missed)", async () => {
  const r = await C.client.req("call:start", { peerId: id(B) });
  assert.ok(r.ok, JSON.stringify(r));
  await waitFor(() => inB.find((e) => e.ev === "call:incoming" && e.data.call.id === r.call.id));
  assert.ok((await C.client.req("call:hangup", { callId: r.call.id })).ok);
  const end = await waitFor(() => stateOf(inB, r.call.id, "ended"));
  assert.equal(end.data.call.outcome, "cancelled");
  const m = await waitFor(() => callMsg(inB, r.call.id));
  assert.match(m.text, /Missed audio call/);
});

test("callee on two devices: both ring; answering on one moves both to active", async () => {
  const c2 = wsClient(app.wsUrl);
  await c2.open;
  const res = await c2.req("session:resume", { token: B.res.access ?? B.res.token ?? B.res.refresh });
  assert.ok(res.ok, JSON.stringify(res).slice(0, 200));
  const box2 = inbox(c2.ws);
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.ok(r.ok);
  await waitFor(() => inB.find((e) => e.ev === "call:incoming" && e.data.call.id === r.call.id));
  if (box2) await waitFor(() => box2.find((e) => e.ev === "call:incoming" && e.data.call.id === r.call.id));
  assert.ok((await B.client.req("call:accept", { callId: r.call.id })).ok);
  if (box2) await waitFor(() => stateOf(box2, r.call.id, "active"));
  // the second device can still see it's live (resume after reconnect)
  const cur = await B.client.req("call:current", {});
  assert.equal(cur.call.id, r.call.id);
  assert.ok((await A.client.req("call:hangup", { callId: r.call.id })).ok);
  await waitFor(() => stateOf(inB, r.call.id, "ended"));
  c2.close();
});

test("busy if the callee is in a live audio room", async () => {
  const c = await B.client.req("room:create", { title: "Bea's room" });
  assert.ok(c.ok);
  assert.ok((await B.client.req("room:join", { roomId: c.roomId })).ok);
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "busy");
  assert.match(r.error, /Bea is on another call/);
  // and you can't start a call from inside a room either
  const r2 = await B.client.req("call:start", { peerId: id(A) });
  assert.equal(r2.reason, "self_busy");
  await B.client.req("room:leave", { roomId: c.roomId });
});

test("blocked either way → can't call", async () => {
  const blk = await api(app.base, "/api/me/blocks", { userId: id(C), block: true }, { token: B.res.access });
  assert.ok(blk.status < 300, JSON.stringify(blk.data).slice(0, 200));
  const r = await C.client.req("call:start", { peerId: id(B) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "blocked");
  await api(app.base, "/api/me/blocks", { userId: id(C), block: false }, { token: B.res.access });
});

test("caller's socket vanishes while ringing → cancelled automatically", async () => {
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.ok(r.ok, JSON.stringify(r));
  await waitFor(() => inB.find((e) => e.ev === "call:incoming" && e.data.call.id === r.call.id));
  A.client.close();
  const end = await waitFor(() => stateOf(inB, r.call.id, "ended"), 3000);
  assert.equal(end.data.call.outcome, "cancelled");
});

test("validation: bad payloads are rejected before the handler", async () => {
  const r = await B.client.req("call:start", { peerId: "../../etc" });
  assert.equal(r.ok, false);
  const r2 = await B.client.req("call:video", { callId: "x" });
  assert.equal(r2.ok, false);
  void wsClient;
});

test("a live call blocks joining an audio room", async () => {
  await B.client.req("dm:send", { to: id(C), text: "we're good again" });
  const r = await C.client.req("call:start", { peerId: id(B) });
  assert.ok(r.ok, JSON.stringify(r));
  const c = await B.client.req("room:create", { title: "x" });
  const j = await B.client.req("room:join", { roomId: c.roomId });
  assert.equal(j.ok, false);
  assert.match(j.error, /Hang up/);
  await C.client.req("call:hangup", { callId: r.call.id });
});
