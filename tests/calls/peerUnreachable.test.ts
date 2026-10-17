// Answered but no first audio from either side, then one side's socket dies (call 67078d15: push-woken callee lost its
// WebView socket 4 s after answering under the iPhone call screen): end after CALL_UNREACHABLE_MS as peer_unreachable
// instead of a silent 45 s reconnect grace. Once audio has flowed, the normal grace applies.
process.env.CALL_RECONNECT_GRACE_MS = "60000";
process.env.CALL_UNREACHABLE_MS = "800";
process.env.CALL_SWEEP_MS = "200";
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
const got: Ev[] = [];
async function waitFor<T>(fn: () => T | undefined | null | false, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out waiting");
    await sleep(20);
  }
}
async function reloginB() {
  const c = wsClient(app.wsUrl);
  await c.open;
  assert.ok((await c.req("session:resume", { token: B.res.access ?? B.res.token ?? B.res.refresh })).ok);
  B = { ...B, client: c };
}
before(async () => {
  await wipeDb();
  app = await startApp();
  A = await phoneLogin(app.wsUrl, phone(), { firstName: "Donny", username: `donny_${uniq()}` });
  B = await phoneLogin(app.wsUrl, phone(), { firstName: "Keiko", username: `keiko_${uniq()}` });
  A.client.ws.on("message", (raw: Buffer) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "evt") got.push({ ev: m.ev, data: m.data, at: Date.now() });
  });
  await B.client.req("dm:send", { to: id(A), text: "call me" });
});
after(async () => {
  A?.client.close();
  B?.client.close();
  await app?.close();
});

test("callee vanishes right after answering, before any audio → ends ~CALL_UNREACHABLE_MS later as peer_unreachable", async () => {
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok((await B.client.req("call:accept", { callId: r.call.id })).ok);
  B.client.close();
  const end = await waitFor(() => got.find((e) => e.ev === "call:state" && e.data.call.id === r.call.id && e.data.call.phase === "ended"), 5000);
  assert.equal(end.data.reason, "peer_unreachable");
  assert.equal(end.data.by, id(B));
  assert.equal(end.data.call.outcome, "completed");
  await reloginB();
});

test("once first audio was reported, a drop keeps the normal reconnect grace (no early end)", async () => {
  await sleep(300);
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok((await B.client.req("call:accept", { callId: r.call.id })).ok);
  assert.ok((await A.client.req("call:metric", { callId: r.call.id, acceptToAudioMs: 900 })).ok);
  B.client.close();
  await sleep(2000);
  const g = await A.client.req("call:get", { callId: r.call.id });
  assert.equal(g.call.phase, "active");
  await A.client.req("call:hangup", { callId: r.call.id });
});
