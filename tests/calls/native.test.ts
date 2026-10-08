// Native ring support (NATIVE_SPEC.md §2): HTTP decline/status for the wrappers, PushKit VoIP tokens + CallKit ring,
// no duplicate iOS alert when CallKit took the call, APNs provider JWT shape. Local Postgres only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import "./env";
import { setTestEnv, startApp, wipeDb, phoneLogin, sql, api, type App } from "../unified-auth/harness";

setTestEnv({ providers: false });
let app: App;
type L = Awaited<ReturnType<typeof phoneLogin>>;
let A: L, B: L, D: L;
const uniq = () => randomBytes(3).toString("hex");
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const id = (x: L) => x.res.user.id as string;
const tok = (x: L) => (x.res.access ?? x.res.token ?? x.res.refresh) as string;
async function waitFor<T>(fn: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out waiting");
    await sleep(20);
  }
}
const voipTok = () => randomBytes(32).toString("hex");

before(async () => {
  await wipeDb();
  app = await startApp();
  A = await phoneLogin(app.wsUrl, phone(), { firstName: "Donny", username: `donny_${uniq()}` });
  B = await phoneLogin(app.wsUrl, phone(), { firstName: "Bea", username: `bea_${uniq()}` });
  D = await phoneLogin(app.wsUrl, phone(), { firstName: "Dee", username: `dee_${uniq()}` });
  await B.client.req("dm:send", { to: id(A), text: "call me" }); // B messaged A → A may call B
});
after(async () => {
  for (const x of [A, B, D]) x?.client.close();
  await app?.close();
});

test("PushKit token: auth required, validated, stored, removable", async () => {
  assert.equal((await api(app.base, "/api/push/voip-token", { token: voipTok() })).status, 401);
  assert.equal((await api(app.base, "/api/push/voip-token", { token: "not-hex" }, { token: tok(B) })).status, 400);
  const t = voipTok();
  const r = await api(app.base, "/api/push/voip-token", { token: t.toUpperCase(), env: "sandbox" }, { token: tok(B) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rows = await sql<{ user_id: string; apns_env: string }>("SELECT user_id, apns_env FROM voip_tokens WHERE token = $1", [t]);
  assert.deepEqual(rows.map((x) => [x.user_id, x.apns_env]), [[id(B), "sandbox"]]);
  assert.equal((await api(app.base, "/api/push/voip-token/remove", { token: t }, { token: tok(B) })).status, 200);
  assert.equal((await sql("SELECT 1 FROM voip_tokens WHERE token = $1", [t])).length, 0);
});

test("decline from the native notification over HTTP; status endpoint is participant-only", async () => {
  const s = await A.client.req("call:start", { peerId: id(B) });
  assert.equal(s.ok, true, JSON.stringify(s));
  const callId = s.call.id as string;
  const g = await api(app.base, `/api/calls/${callId}`, undefined, { token: tok(B) });
  assert.equal(g.status, 200);
  assert.match(g.data.call.phase, /^(calling|ringing)$/);
  assert.equal(g.data.token, undefined); // never a LiveKit token here
  assert.equal((await api(app.base, `/api/calls/${callId}`, undefined, { token: tok(D) })).status, 404);
  assert.equal((await api(app.base, `/api/calls/${callId}/decline`, {}, { token: tok(D) })).status, 404);
  const d = await api(app.base, `/api/calls/${callId}/decline`, {}, { token: tok(B) });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  const after_ = await api(app.base, `/api/calls/${callId}`, undefined, { token: tok(B) });
  assert.equal(after_.data.call.phase, "ended");
  assert.equal(after_.data.call.outcome, "declined");
  assert.equal((await api(app.base, `/api/calls/../../etc`, undefined, { token: tok(B) })).status, 404);
});

test("CallKit: a backgrounded iPhone rings via VoIP push and gets no duplicate iOS alert", async () => {
  const { initVoip, MemoryVoipStore } = await import("../../server/calls/voip");
  const { push, initPush } = await import("../../server/push");
  const { MemorySender } = await import("../../server/push/sender");
  const { MemoryPushRepo } = await import("../../server/push/repo");
  if (!push()) initPush({ repo: new MemoryPushRepo(), sender: new MemorySender() });
  const rang: { token: string; payload: Record<string, string>; exp: number }[] = [];
  initVoip({ store: new MemoryVoipStore(), sender: { send: async (t, payload, exp) => (rang.push({ token: t.token, payload, exp }), { ok: true, status: 200 }) } });
  const vt = voipTok();
  assert.equal((await api(app.base, "/api/push/voip-token", { token: vt }, { token: tok(B) })).status, 200);
  assert.equal((await api(app.base, "/api/push/register", { token: "ios-fcm-" + "x".repeat(40), platform: "ios" }, { token: tok(B) })).status, 200);
  assert.equal((await api(app.base, "/api/push/register", { token: "and-fcm-" + "y".repeat(40), platform: "android" }, { token: tok(B) })).status, 200);
  await B.client.req("presence:visible", { visible: false });
  const sender = (push() as unknown as { d: { sender: { sent: { tokens: { platform: string }[]; msg: { type?: string; data?: Record<string, string> } }[] } } }).d.sender;
  const before_ = sender.sent.length;
  const s = await A.client.req("call:start", { peerId: id(B), video: true });
  assert.equal(s.ok, true, JSON.stringify(s));
  const v = await waitFor(() => rang.find((x) => x.payload.callId === s.call.id));
  assert.equal(v.token, vt);
  assert.equal(v.payload.type, "call_incoming");
  assert.equal(v.payload.callerName, "Donny");
  assert.equal(v.payload.video, "1");
  assert.equal(v.exp, s.call.expiresAt);
  const fcm = await waitFor(() => sender.sent.slice(before_).find((x) => x.msg.data?.callId === s.call.id));
  assert.deepEqual(fcm.tokens.map((t) => t.platform), ["android"]); // the iPhone already rings through CallKit
  await A.client.req("call:hangup", { callId: s.call.id });
  await B.client.req("presence:visible", { visible: true });
});

test("APNs provider token: ES256 JWT with kid/iss, cached ~50 min", async () => {
  const { ApnsVoipSender, apnsConfigFromEnv, deadToken } = await import("../../server/calls/voip");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.equal(apnsConfigFromEnv({}), null);
  const cfg = apnsConfigFromEnv({ APNS_KEY_P8: pem.replace(/\n/g, "\\n"), APNS_KEY_ID: "KEY123", APNS_TEAM_ID: "TEAM456", APNS_BUNDLE_ID: "app.openlounge" });
  assert.ok(cfg);
  assert.equal(cfg!.topic, "app.openlounge.voip");
  let now = 1_800_000_000_000;
  const s = new ApnsVoipSender(cfg!, () => now);
  const j = s.providerToken();
  const [h, b, sig] = j.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "ES256", kid: "KEY123" });
  assert.deepEqual(JSON.parse(Buffer.from(b, "base64url").toString()), { iss: "TEAM456", iat: 1_800_000_000 });
  assert.ok(verify("sha256", Buffer.from(`${h}.${b}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));
  now += 10 * 60_000;
  assert.equal(s.providerToken(), j);
  now += 45 * 60_000;
  assert.notEqual(s.providerToken(), j);
  assert.equal(deadToken({ ok: false, status: 410 }), true);
  assert.equal(deadToken({ ok: false, status: 400, reason: "BadDeviceToken" }), true);
  assert.equal(deadToken({ ok: false, status: 429, reason: "TooManyRequests" }), false);
});

test("Calls tab: call:history lists my call service messages newest first with peers; blocks hide them", async () => {
  const h = await A.client.req("call:history", {});
  assert.equal(h.ok, true);
  assert.ok(h.calls.length >= 2, JSON.stringify(h));
  assert.ok(h.calls.every((m: any) => m.kind === "call" && m.call));
  assert.ok(h.calls[0].createdAt >= h.calls[h.calls.length - 1].createdAt);
  assert.equal(h.peers[id(B)].name, "Bea");
  const hb = await B.client.req("call:history", {});
  assert.equal(hb.calls.length, h.calls.length);
  assert.deepEqual((await D.client.req("call:history", {})).calls, []);
  await api(app.base, "/api/me/blocks", { userId: id(A), block: true }, { token: tok(B) });
  assert.deepEqual((await B.client.req("call:history", {})).calls, []);
  await api(app.base, "/api/me/blocks", { userId: id(A), block: false }, { token: tok(B) });
  assert.equal((await A.client.req("call:history", { before: "x" })).ok, false);
});
