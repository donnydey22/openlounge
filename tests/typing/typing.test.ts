// DM typing indicators: two real WebSocket clients against the app server (local Postgres only).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import "./env";
import { setTestEnv, startApp, wipeDb, api, phoneLogin, sql, type App } from "../unified-auth/harness";

setTestEnv({ providers: false });
let app: App;
type L = Awaited<ReturnType<typeof phoneLogin>>;
let A: L, B: L, C: L;
const uniq = () => randomBytes(3).toString("hex");
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function inbox(x: L) {
  const got: { ev: string; data: any }[] = [];
  x.client.ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "evt" && String(m.ev).startsWith("dm:typing")) got.push({ ev: m.ev, data: m.data });
  });
  return got;
}
const emit = (x: L, ev: string, data: unknown) => x.client.ws.send(JSON.stringify({ t: "evt", ev, data }));
let inA: ReturnType<typeof inbox>, inB: ReturnType<typeof inbox>, inC: ReturnType<typeof inbox>;

before(async () => {
  await wipeDb();
  app = await startApp();
  A = await phoneLogin(app.wsUrl, phone(), { firstName: "Alice", username: `alice_${uniq()}` });
  B = await phoneLogin(app.wsUrl, phone(), { firstName: "Bob", username: `bob_${uniq()}` });
  C = await phoneLogin(app.wsUrl, phone(), { firstName: "Cara", username: `cara_${uniq()}` });
  inA = inbox(A); inB = inbox(B); inC = inbox(C);
});
after(async () => {
  for (const x of [A, B, C]) x?.client.close();
  await app?.close();
});
const reset = () => { inA.length = 0; inB.length = 0; inC.length = 0; };

test("typing + typing_stop relay only to the addressed peer", async () => {
  reset();
  emit(A, "dm:typing", { to: B.res.user.id });
  await sleep(200);
  emit(A, "dm:typing_stop", { to: B.res.user.id });
  await sleep(200);
  assert.deepEqual(inB.map((e) => e.ev), ["dm:typing", "dm:typing_stop"]);
  assert.equal(inB[0].data.from, A.res.user.id);
  assert.equal(inC.length, 0, "third party sees nothing");
  assert.equal(inA.length, 0, "sender gets no echo");
});

test("typing is never persisted", async () => {
  const rows = await sql("SELECT count(*)::int AS n FROM dms");
  assert.equal((rows[0] as any).n, 0);
  const h = await B.client.req("dm:history", { peerId: A.res.user.id });
  assert.equal(h.messages.length, 0);
});

test("rate limit: bursts collapse to ≤1 typing per second per peer", async () => {
  await sleep(1100);
  reset();
  for (let i = 0; i < 15; i++) emit(A, "dm:typing", { to: B.res.user.id });
  await sleep(300);
  assert.equal(inB.filter((e) => e.ev === "dm:typing").length, 1);
});

test("self, unknown and malformed targets are dropped", async () => {
  await sleep(1100);
  reset();
  emit(A, "dm:typing", { to: A.res.user.id });
  emit(A, "dm:typing", { to: "u_doesnotexist" });
  emit(A, "dm:typing", {});
  await sleep(300);
  assert.equal(inA.length + inB.length + inC.length, 0);
});

test("blocked either way → no typing relay", async () => {
  await sleep(1100);
  const r = await api(app.base, "/api/me/blocks", { userId: A.res.user.id, block: true }, { token: B.res.access });
  assert.equal(r.status, 200);
  reset();
  emit(A, "dm:typing", { to: B.res.user.id }); // blocked sender → recipient
  emit(B, "dm:typing", { to: A.res.user.id }); // blocker → blocked
  await sleep(300);
  assert.equal(inA.length + inB.length, 0);
  await api(app.base, "/api/me/blocks", { userId: A.res.user.id, block: false }, { token: B.res.access });
  await sleep(1100);
  emit(A, "dm:typing", { to: B.res.user.id });
  await sleep(300);
  assert.equal(inB.length, 1, "restored after unblock");
});

test("sender disconnect mid-typing → peer gets typing_stop", async () => {
  await sleep(1100);
  const D = await phoneLogin(app.wsUrl, phone(), { firstName: "Dee", username: `dee_${uniq()}` });
  reset();
  emit(D, "dm:typing", { to: B.res.user.id });
  await sleep(200);
  D.client.close();
  await sleep(400);
  assert.deepEqual(inB.map((e) => e.ev), ["dm:typing", "dm:typing_stop"]);
});
