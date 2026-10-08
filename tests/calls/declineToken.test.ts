// Per-call decline token (server/calls/declineToken.ts): Decline from CallKit / the Android call screen works with no
// session (expired 1-hour access token). Scoped to one call + callee, expires with the ring, single-use.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import "./env";
import { setTestEnv, startApp, wipeDb, phoneLogin, api, type App } from "../unified-auth/harness";
import { DeclineTokens, DECLINE_TOKEN_GRACE_MS } from "../../server/calls/declineToken";

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
const H = (t: string) => ({ headers: { "X-Call-Decline-Token": t } });

// ---------- unit: the token itself ----------
test("unit: mint/verify, scope, expiry at ring deadline + grace, replay, tamper", () => {
  let now = 1_800_000_000_000;
  const t = new DeclineTokens("unit-secret-0123456789abcdef", () => now);
  const deadline = now + 45_000;
  const a = t.mint("call1", "userB", deadline);
  assert.match(a, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(t.verify(a, "call2"), { ok: false, reason: "wrong_call" });
  const ok = t.verify(a, "call1");
  assert.deepEqual(ok, { ok: true, callId: "call1", userId: "userB" });
  assert.deepEqual(t.verify(a, "call1"), { ok: false, reason: "replayed" });
  // expiry: valid right up to deadline + grace, rejected 1 ms later
  const b = t.mint("call1", "userB", deadline);
  now = deadline + DECLINE_TOKEN_GRACE_MS + 1;
  assert.deepEqual(t.verify(b, "call1"), { ok: false, reason: "expired" });
  now = 1_800_000_000_000;
  const c = t.mint("call1", "userB", deadline);
  now = deadline + DECLINE_TOKEN_GRACE_MS;
  assert.equal(t.verify(c, "call1").ok, true);
  now = 1_800_000_000_000;
  assert.ok(DECLINE_TOKEN_GRACE_MS > 0 && DECLINE_TOKEN_GRACE_MS <= 30_000);
  // tampering: swap the callee in the claims, keep the signature
  const d = t.mint("call1", "userB", deadline);
  const [v, body, sig] = d.split(".");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  const forged = `${v}.${Buffer.from(JSON.stringify({ ...claims, u: "userX" })).toString("base64url")}.${sig}`;
  assert.deepEqual(t.verify(forged, "call1"), { ok: false, reason: "signature" });
  // another server key can't verify ours
  assert.deepEqual(new DeclineTokens("other-secret-0123456789abcdef", () => now).verify(t.mint("call1", "userB", deadline), "call1"), { ok: false, reason: "signature" });
  for (const junk of [undefined, "", "v1.x", "v2.a.b", "v1.!!.??", "x".repeat(700), 42]) assert.equal(t.verify(junk, "call1").ok, false);
  // random per-process key when no secret is configured
  const r1 = new DeclineTokens(undefined, () => now), r2 = new DeclineTokens(undefined, () => now);
  assert.equal(r2.verify(r1.mint("c", "u", deadline), "c").ok, false);
});

// ---------- integration: the real ring push + HTTP decline with NO session ----------
type Rang = { token: string; payload: Record<string, string>; exp: number };
const rang: Rang[] = [];
let sender: { sent: { tokens: { platform: string }[]; msg: { data?: Record<string, string> } }[] };

before(async () => {
  await wipeDb();
  app = await startApp();
  A = await phoneLogin(app.wsUrl, phone(), { firstName: "Donny", username: `donny_${uniq()}` });
  B = await phoneLogin(app.wsUrl, phone(), { firstName: "Bea", username: `bea_${uniq()}` });
  D = await phoneLogin(app.wsUrl, phone(), { firstName: "Dee", username: `dee_${uniq()}` });
  await B.client.req("dm:send", { to: id(A), text: "call me" });
  await D.client.req("dm:send", { to: id(A), text: "call me too" });
  const { initVoip, MemoryVoipStore } = await import("../../server/calls/voip");
  const { push, initPush } = await import("../../server/push");
  const { MemorySender } = await import("../../server/push/sender");
  const { MemoryPushRepo } = await import("../../server/push/repo");
  if (!push()) initPush({ repo: new MemoryPushRepo(), sender: new MemorySender() });
  initVoip({ store: new MemoryVoipStore(), sender: { send: async (t, payload, exp) => (rang.push({ token: t.token, payload, exp }), { ok: true, status: 200 }) } });
  sender = (push() as unknown as { d: { sender: typeof sender } }).d.sender;
  // B: an iPhone (VoIP) + an Android phone (FCM); D: Android only
  assert.equal((await api(app.base, "/api/push/voip-token", { token: randomBytes(32).toString("hex") }, { token: tok(B) })).status, 200);
  assert.equal((await api(app.base, "/api/push/register", { token: "and-fcm-" + "b".repeat(40), platform: "android" }, { token: tok(B) })).status, 200);
  assert.equal((await api(app.base, "/api/push/register", { token: "and-fcm-" + "d".repeat(40), platform: "android" }, { token: tok(D) })).status, 200);
  await B.client.req("presence:visible", { visible: false });
  await D.client.req("presence:visible", { visible: false });
});
after(async () => {
  for (const x of [A, B, D]) x?.client.close();
  await app?.close();
});

async function ring(callee: L) {
  const before_ = sender.sent.length;
  const s = await A.client.req("call:start", { peerId: id(callee) });
  assert.equal(s.ok, true, JSON.stringify(s));
  const callId = s.call.id as string;
  const fcm = await waitFor(() => sender.sent.slice(before_).find((x) => x.msg.data?.callId === callId && x.msg.data?.declineToken));
  return { callId, fcm: fcm.msg.data!.declineToken, voip: rang.find((x) => x.payload.callId === callId)?.payload.declineToken, expiresAt: s.call.expiresAt as number };
}
const phaseOf = async (callId: string) => (await api(app.base, `/api/calls/${callId}`, undefined, { token: tok(A) })).data.call;

test("ring push carries the token on BOTH surfaces (VoIP + FCM); Decline works with no session; replay rejected", async () => {
  const r = await ring(B);
  assert.ok(r.voip, "VoIP payload has declineToken");
  assert.equal(r.voip, r.fcm); // one token per ring, shared by the iPhone and the Android phone
  // no Authorization header at all (expired session = the wrapper has nothing valid to send)
  const d = await api(app.base, `/api/calls/${r.callId}/decline`, {}, H(r.fcm));
  assert.equal(d.status, 200, JSON.stringify(d.data));
  assert.equal(d.data.phase, "ended");
  const c = await phaseOf(r.callId);
  assert.equal(c.phase, "ended");
  assert.equal(c.outcome, "declined");
  // replay (same token again, header or body) → 409 replayed
  const again = await api(app.base, `/api/calls/${r.callId}/decline`, {}, H(r.fcm));
  assert.equal(again.status, 409);
  assert.equal(again.data.reason, "replayed");
  assert.equal((await api(app.base, `/api/calls/${r.callId}/decline`, { declineToken: r.fcm })).status, 409);
});

test("body form {declineToken} works too (no session)", async () => {
  const r = await ring(B);
  const d = await api(app.base, `/api/calls/${r.callId}/decline`, { declineToken: r.fcm });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  assert.equal((await phaseOf(r.callId)).outcome, "declined");
});

test("wrong call: B's token for call 1 can't decline call 2", async () => {
  const r1 = await ring(B);
  await A.client.req("call:hangup", { callId: r1.callId });
  const r2 = await ring(B);
  const d = await api(app.base, `/api/calls/${r2.callId}/decline`, {}, H(r1.fcm));
  assert.equal(d.status, 401);
  assert.equal(d.data.reason, "wrong_call");
  assert.match((await phaseOf(r2.callId)).phase, /^(calling|ringing)$/); // still ringing
  // and the right token still works afterwards (a failed attempt doesn't burn it)
  assert.equal((await api(app.base, `/api/calls/${r2.callId}/decline`, {}, H(r2.fcm))).status, 200);
});

test("wrong user: a token minted for someone other than the callee is refused; forged token refused", async () => {
  const r = await ring(B);
  const { declineTokens } = await import("../../server/calls/declineToken");
  const forCaller = declineTokens().mint(r.callId, id(A), r.expiresAt); // the caller isn't the callee
  const d = await api(app.base, `/api/calls/${r.callId}/decline`, {}, H(forCaller));
  assert.equal(d.status, 403);
  assert.equal(d.data.reason, "wrong_user");
  const forStranger = declineTokens().mint(r.callId, id(D), r.expiresAt); // not a participant at all
  const d2 = await api(app.base, `/api/calls/${r.callId}/decline`, {}, H(forStranger));
  assert.equal(d2.status, 404);
  assert.match((await phaseOf(r.callId)).phase, /^(calling|ringing)$/); // the stranger's "decline" did nothing
  // tamper with B's real token → signature
  const [v, body, sig] = r.fcm.split(".");
  const cl = JSON.parse(Buffer.from(body, "base64url").toString());
  const forged = `${v}.${Buffer.from(JSON.stringify({ ...cl, u: id(D) })).toString("base64url")}.${sig}`;
  const d3 = await api(app.base, `/api/calls/${r.callId}/decline`, {}, H(forged));
  assert.equal(d3.status, 401);
  assert.equal(d3.data.reason, "signature");
  await A.client.req("call:hangup", { callId: r.callId });
});

test("expired: a token past ring deadline + grace is refused (no session)", async () => {
  const r = await ring(B);
  const { declineTokens } = await import("../../server/calls/declineToken");
  const stale = declineTokens().mint(r.callId, id(B), Date.now() - DECLINE_TOKEN_GRACE_MS - 1000);
  const d = await api(app.base, `/api/calls/${r.callId}/decline`, {}, H(stale));
  assert.equal(d.status, 401);
  assert.equal(d.data.reason, "expired");
  await A.client.req("call:hangup", { callId: r.callId });
});

test("no token and no session → 401; garbage token → 401; a valid session still declines when the token fails", async () => {
  const r = await ring(B);
  assert.equal((await api(app.base, `/api/calls/${r.callId}/decline`, {})).status, 401);
  assert.equal((await api(app.base, `/api/calls/${r.callId}/decline`, {}, H("v1.junk.junk"))).status, 401);
  // stale token + good bearer → the session path declines
  const d = await api(app.base, `/api/calls/${r.callId}/decline`, {}, { token: tok(B), headers: { "X-Call-Decline-Token": "v1.junk.junk" } });
  assert.equal(d.status, 200, JSON.stringify(d.data));
});

test("token can't hang up an answered call; caller-cancelled call → 200 ended", async () => {
  const r = await ring(D);
  const acc = await D.client.req("call:accept", { callId: r.callId });
  assert.equal(acc.ok, true, JSON.stringify(acc));
  const d = await api(app.base, `/api/calls/${r.callId}/decline`, {}, H(r.fcm));
  assert.equal(d.status, 409);
  assert.equal(d.data.reason, "answered");
  assert.equal((await phaseOf(r.callId)).phase, "active");
  await A.client.req("call:hangup", { callId: r.callId });
  const r2 = await ring(D);
  await A.client.req("call:hangup", { callId: r2.callId });
  const d2 = await api(app.base, `/api/calls/${r2.callId}/decline`, {}, H(r2.fcm));
  assert.equal(d2.status, 200);
  assert.equal(d2.data.phase, "ended");
});

test("expired session: a stale/invalid bearer + valid token still declines", async () => {
  const r = await ring(B);
  const d = await api(app.base, `/api/calls/${r.callId}/decline`, {}, { token: "expired.access.token", headers: { "X-Call-Decline-Token": r.fcm } });
  assert.equal(d.status, 200, JSON.stringify(d.data));
  assert.equal((await phaseOf(r.callId)).outcome, "declined");
});
