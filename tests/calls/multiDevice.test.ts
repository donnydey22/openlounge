// Same account on several devices (iPhone + web + Android): every device rings, first accept wins, the others stop;
// decline on one stops all; push tokens are per device and pruned individually. Real WS clients + local Postgres.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import "./env";
import { setTestEnv, startApp, wipeDb, phoneLogin, wsClient, type App } from "../unified-auth/harness";
import { Notifier } from "../../server/push/notifier";
import { MemoryPushRepo } from "../../server/push/repo";
import { MemorySender } from "../../server/push/sender";

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
async function device(x: L) {
  const c = wsClient(app.wsUrl);
  await c.open;
  const res = await c.req("session:resume", { token: x.res.access ?? x.res.token ?? x.res.refresh });
  assert.ok(res.ok, JSON.stringify(res).slice(0, 200));
  return { c, box: inbox(c.ws) };
}

before(async () => {
  await wipeDb();
  app = await startApp();
  A = await phoneLogin(app.wsUrl, phone(), { firstName: "Ann", username: `ann_${uniq()}` });
  B = await phoneLogin(app.wsUrl, phone(), { firstName: "Bo", username: `bo_${uniq()}` });
  assert.ok((await B.client.req("dm:send", { to: id(A), text: "call me" })).ok);
  assert.ok((await A.client.req("dm:send", { to: id(B), text: "ok" })).ok);
});
after(async () => {
  A?.client.close();
  B?.client.close();
  await app?.close();
});

test("MD server: 3 sockets for one user all ring; first accept wins, the others see active within 1 s; a simultaneous accept loses", async () => {
  const devs = [{ c: B.client, box: inbox(B.client.ws) }, await device(B), await device(B)];
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.ok(r.ok);
  for (const d of devs) await waitFor(() => d.box.find((e) => e.ev === "call:incoming" && e.data.call.id === r.call.id));
  const [w, l] = await Promise.all([devs[1].c.req("call:accept", { callId: r.call.id }), devs[2].c.req("call:accept", { callId: r.call.id })]);
  assert.equal([w, l].filter((x) => x.ok).length, 1, "exactly one accept wins");
  const loser = [w, l].find((x) => !x.ok);
  assert.equal(loser.reason, "answered_elsewhere");
  assert.equal(loser.media, undefined, "the losing device gets no media credential");
  const t0 = Date.now();
  for (const d of devs) await waitFor(() => stateOf(d.box, r.call.id, "active"), 1000);
  assert.ok(Date.now() - t0 < 1000);
  assert.ok((await A.client.req("call:hangup", { callId: r.call.id })).ok);
  for (const d of devs) await waitFor(() => stateOf(d.box, r.call.id, "ended"));
  devs[1].c.close();
  devs[2].c.close();
});

test("MD server: decline on one device stops ringing on all of them", async () => {
  const devs = [{ c: B.client, box: inbox(B.client.ws) }, await device(B)];
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.ok(r.ok);
  for (const d of devs) await waitFor(() => d.box.find((e) => e.ev === "call:incoming" && e.data.call.id === r.call.id));
  assert.ok((await devs[1].c.req("call:decline", { callId: r.call.id })).ok);
  for (const d of devs) await waitFor(() => stateOf(d.box, r.call.id, "ended"), 1000);
  devs[1].c.close();
});

test("MD server: the same device re-accepting after a reconnect is still allowed", async () => {
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.ok(r.ok);
  const d1 = await device(B);
  await waitFor(() => d1.box.find((e) => e.ev === "call:incoming" && e.data.call.id === r.call.id) || true);
  assert.ok((await d1.c.req("call:accept", { callId: r.call.id })).ok);
  d1.c.close();
  await sleep(150);
  const d2 = await device(B);
  assert.ok((await d2.c.req("call:accept", { callId: r.call.id })).ok, "reconnected device resumes its call");
  assert.ok((await A.client.req("call:hangup", { callId: r.call.id })).ok);
  d2.c.close();
});

test("MD push: 3 tokens per user all receive; a failing token removes only itself; cancel reaches all; sign-out drops one", async () => {
  const repo = new MemoryPushRepo();
  const sender = new MemorySender();
  const n = new Notifier({ repo, sender, isForeground: () => false, userName: () => "Ann", followerIds: () => [], followingIds: () => [], usersWithPhones: () => [] });
  const toks = { ios: "tok-ios-0123456789abcdef0123456789", android: "tok-and-0123456789abcdef0123456789", web: "tok-web-0123456789abcdef0123456789" };
  for (const [p, t] of Object.entries(toks)) await n.registerToken("u_b", t, p as "ios");
  assert.equal((await repo.tokensFor("u_b")).length, 3);
  const call = { id: "c9", callerId: "u_a", video: false, expiresAt: Date.now() + 45_000, caller: { name: "Ann", photoUrl: "" } };
  assert.equal(await n.callIncoming("u_b", call), "sent");
  assert.equal(sender.sent.at(-1)!.tokens.length, 3);
  sender.invalid.add(toks.android);
  await n.callCancel("u_b", "c9", "answered");
  assert.equal(sender.sent.at(-1)!.msg.type, "call_cancel");
  assert.equal(sender.sent.at(-1)!.tokens.length, 3, "stop-ring goes to every device (closed iPhone included)");
  assert.deepEqual((await repo.tokensFor("u_b")).map((t) => t.token).sort(), [toks.ios, toks.web].sort());
  await n.unregisterToken("u_b", toks.web);
  assert.deepEqual((await repo.tokensFor("u_b")).map((t) => t.token), [toks.ios]);
});

test("MD-1 / in-call indicator: the caller's OTHER device and the callee's non-answering device both get call:state active (pill), then ended", async () => {
  const a2 = await device(A);
  const b2 = await device(B);
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.ok(r.ok);
  await waitFor(() => b2.box.find((e) => e.ev === "call:incoming" && e.data.call.id === r.call.id));
  assert.ok((await B.client.req("call:accept", { callId: r.call.id })).ok);
  await waitFor(() => stateOf(a2.box, r.call.id, "active"), 1000);
  await waitFor(() => stateOf(b2.box, r.call.id, "active"), 1000);
  assert.ok((await A.client.req("call:hangup", { callId: r.call.id })).ok);
  await waitFor(() => stateOf(a2.box, r.call.id, "ended"));
  await waitFor(() => stateOf(b2.box, r.call.id, "ended"));
  a2.c.close();
  b2.c.close();
});

test("MD-6: a 4th device signing in kicks no one: all 4 get the next DM live; closing one leaves the others", async () => {
  const devs = [{ c: B.client, box: inbox(B.client.ws) }, await device(B), await device(B), await device(B)];
  const text = "md6 " + uniq();
  assert.ok((await A.client.req("dm:send", { to: id(B), text })).ok);
  for (const d of devs) await waitFor(() => d.box.find((e) => JSON.stringify(e.data ?? "").includes(text)));
  devs[3].c.close();
  await sleep(200);
  const text2 = "md6b " + uniq();
  assert.ok((await A.client.req("dm:send", { to: id(B), text: text2 })).ok);
  for (const d of devs.slice(0, 3)) await waitFor(() => d.box.find((e) => JSON.stringify(e.data ?? "").includes(text2)));
  devs[1].c.close();
  devs[2].c.close();
});

test("MD-8: headset follow / mic routing starts only on the device that connects media, never while ringing", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  const incoming = src.slice(src.indexOf("private onIncoming"), src.indexOf("async accept("));
  assert.ok(!incoming.includes("followAudioDevices"), "ring path must not start headset follow");
  const elsewhere = src.slice(src.indexOf("answered on another device"), src.indexOf("answered on another device") + 800);
  assert.ok(elsewhere.includes("teardownMedia()"), "answered elsewhere releases any pre-acquired mic");
});
