// Stale re-dial: re-dialing the same person during the reconnect grace, after their page/app is gone (even if they are
// already back on a fresh page that doesn't know the call), ends the stale call and rings fresh. A live call is still
// handed back (double tap / second tab). Grace kept long (60 s) so only the new rule can end the stale call.
process.env.CALL_RECONNECT_GRACE_MS = "60000";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import "./env";
import { setTestEnv, startApp, wipeDb, phoneLogin, wsClient, type App } from "../unified-auth/harness";

setTestEnv({ providers: false });
let app: App;
type L = Awaited<ReturnType<typeof phoneLogin>>;
let A: L, B: L;
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
async function waitFor<T>(fn: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out waiting");
    await sleep(20);
  }
}
let inA: Ev[];
async function activeCall() {
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok((await B.client.req("call:accept", { callId: r.call.id })).ok);
  return r.call.id as string;
}
async function reconnect(X: L) {
  const c = wsClient(app.wsUrl);
  await c.open;
  const res = await c.req("session:resume", { token: X.res.access ?? X.res.token ?? X.res.refresh });
  assert.ok(res.ok);
  return c;
}

before(async () => {
  await wipeDb();
  app = await startApp();
  A = await phoneLogin(app.wsUrl, phone(), { firstName: "Donny", username: `donny_${uniq()}` });
  B = await phoneLogin(app.wsUrl, phone(), { firstName: "Bea", username: `bea_${uniq()}` });
  inA = inbox(A.client.ws);
  await B.client.req("dm:send", { to: id(A), text: "call me" });
});
after(async () => {
  A?.client.close();
  B?.client.close();
  await app?.close();
});

test("live call: re-dial (double tap / second tab) still hands back the same call", async () => {
  const callId = await activeCall();
  const again = await A.client.req("call:start", { peerId: id(B) });
  assert.ok(again.ok, JSON.stringify(again));
  assert.equal(again.call.id, callId);
  assert.ok((await A.client.req("call:hangup", { callId })).ok);
});

test("callee's page gone, back on a fresh page: caller re-dial within the grace ends the stale call and rings fresh", async () => {
  const callId = await activeCall();
  B.client.close();
  await sleep(150);
  const b2 = await reconnect(B); // fresh page: connected, but not in the call
  const inB2 = inbox(b2.ws);
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.ok(r.ok, JSON.stringify(r));
  assert.notEqual(r.call.id, callId, "must not re-attach to the stale call");
  assert.notEqual(r.call.phase, "active");
  const ring = await waitFor(() => inB2.find((e) => e.ev === "call:incoming" && e.data.call.id === r.call.id));
  assert.ok(ring);
  const old = await A.client.req("call:get", { callId });
  assert.equal(old.call.phase, "ended");
  assert.ok((await b2.req("call:accept", { callId: r.call.id })).ok);
  assert.ok((await A.client.req("call:hangup", { callId: r.call.id })).ok);
  B = { ...B, client: b2 } as L;
});

test("callee's page gone and not back: re-dial rings fresh (no 'reconnecting' stuck state)", async () => {
  const callId = await activeCall();
  B.client.close();
  await sleep(150);
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.ok(r.ok, JSON.stringify(r));
  assert.notEqual(r.call.id, callId);
  assert.equal((await A.client.req("call:get", { callId })).call.phase, "ended");
  assert.ok((await A.client.req("call:hangup", { callId: r.call.id })).ok);
  B = { ...B, client: await reconnect(B) } as L;
});

test("callee re-synced on a new page (call:get) is live again: re-dial hands back the same call", async () => {
  const callId = await activeCall();
  B.client.close();
  await sleep(150);
  const b2 = await reconnect(B);
  assert.ok((await b2.req("call:get", { callId })).ok);
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.equal(r.call.id, callId);
  assert.ok((await A.client.req("call:hangup", { callId })).ok);
  B = { ...B, client: b2 } as L;
});
