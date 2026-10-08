// Mid-call reconnect grace (server): a participant may lose every socket for CALL_RECONNECT_GRACE_MS without the call
// ending; the other side is told (call:peer offline/online); past the grace it ends as completed/connection_lost,
// never as missed. Grace shortened to 1.2 s here.
process.env.CALL_RECONNECT_GRACE_MS = "1200";
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
async function reconnectB() {
  const c = wsClient(app.wsUrl);
  await c.open;
  const res = await c.req("session:resume", { token: B.res.access ?? B.res.token ?? B.res.refresh });
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

test("a drop shorter than the grace keeps the call; the other side sees offline → online; call:get re-syncs", async () => {
  const callId = await activeCall();
  B.client.close();
  const off = await waitFor(() => inA.find((e) => e.ev === "call:peer" && e.data.callId === callId && e.data.online === false));
  assert.equal(off.data.userId, id(B));
  assert.equal(off.data.graceMs, 1200);
  const cur = await A.client.req("call:get", { callId });
  assert.deepEqual(cur.call.offline, [id(B)]);
  await sleep(600);
  const c = await reconnectB();
  B = { ...B, client: c };
  await waitFor(() => inA.find((e) => e.ev === "call:peer" && e.data.callId === callId && e.data.online === true));
  await sleep(1500); // well past the grace measured from the drop: still live
  const g = await B.client.req("call:get", { callId });
  assert.equal(g.call.phase, "active");
  assert.equal(g.call.offline, undefined);
  assert.ok(g.media?.token, "fresh LiveKit token on re-sync");
  assert.equal((await B.client.req("call:current", {})).call?.id, callId);
  assert.equal(inA.filter((e) => e.ev === "call:state" && e.data.call.id === callId && e.data.call.phase === "ended").length, 0);
  await A.client.req("call:hangup", { callId });
});

test("a drop longer than the grace ends the call as completed / connection_lost (not missed)", async () => {
  await sleep(300);
  const callId = await activeCall();
  await sleep(1100); // some talk time
  B.client.close();
  const end = await waitFor(() => inA.find((e) => e.ev === "call:state" && e.data.call.id === callId && e.data.call.phase === "ended"), 6000);
  assert.equal(end.data.call.outcome, "completed");
  assert.equal(end.data.reason, "connection_lost");
  assert.equal(end.data.by, id(B));
  const off = inA.find((e) => e.ev === "call:peer" && e.data.callId === callId && e.data.online === false)!;
  assert.ok(end.at - off.at >= 1100, `ended ${end.at - off.at}ms after the drop`);
  const msg = await waitFor(() => inA.find((e) => e.ev === "dm:message" && e.data.call?.id === callId));
  assert.equal(msg.data.call.outcome, "completed");
  assert.ok(msg.data.call.durationSec >= 1);
  const c = await reconnectB();
  B = { ...B, client: c };
  assert.equal((await B.client.req("call:current", {})).call, null);
});
