// P2P calling authentication: live participants only, short-lived TURN, no retired media-server tokens.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { fakeLiveKit, listenFakeLiveKit, twirp } from "./media-env";
import "./env";
import { AccessToken } from "livekit-server-sdk";
import { setTestEnv, startApp, wipeDb, phoneLogin, type App } from "../unified-auth/harness";

// A deliberately fake test-only secret; production configuration remains entirely external to Git.
process.env.TURN_STATIC_SECRET = "turn-media-test-secret-not-production";
setTestEnv({ providers: false });
let app: App;
type L = Awaited<ReturnType<typeof phoneLogin>>;
let A: L, B: L, C: L;
const uniq = () => randomBytes(3).toString("hex");
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const id = (x: L) => x.res.user.id as string;
const jwt = (t: string) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());
const now = () => Math.floor(Date.now() / 1000);

async function webhook(event: string, room: string, identity: string) {
  const body = JSON.stringify({ id: `EV_${uniq()}${uniq()}`, event, createdAt: String(now()), room: { name: room }, participant: { identity, sid: `PA_${uniq()}` } });
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  at.sha256 = createHash("sha256").update(body).digest("base64");
  const r = await fetch(`${app.base}/api/livekit/webhook`, { method: "POST", headers: { Authorization: await at.toJwt(), "Content-Type": "application/webhook+json" }, body });
  return r.status;
}
const kicks = (room: string, since: number) => twirp.filter((t) => t.at >= since && t.body?.room === room);

before(async () => {
  await listenFakeLiveKit();
  await wipeDb();
  app = await startApp();
  A = await phoneLogin(app.wsUrl, phone(), { firstName: "Ana", username: `ana_${uniq()}` });
  B = await phoneLogin(app.wsUrl, phone(), { firstName: "Ben", username: `ben_${uniq()}` });
  C = await phoneLogin(app.wsUrl, phone(), { firstName: "Cy", username: `cy_${uniq()}` });
  assert.ok((await B.client.req("dm:send", { to: id(A), text: "call me" })).ok);
  assert.ok((await A.client.req("dm:send", { to: id(B), text: "ok" })).ok);
});
after(async () => {
  for (const x of [A, B, C]) x?.client.close();
  await app?.close();
  fakeLiveKit.close();
});

test("P2P credentials: scoped to live participants, bounded TURN expiry, refreshed and revoked on end", async () => {
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.ok(r.ok, JSON.stringify(r));
  const callId = r.call.id as string;
  assert.equal(r.media.provider, "p2p");
  assert.equal(r.media.url, "rtc");
  assert.equal(r.media.token, "");
  const ca = r.media.iceServers[0];
  assert.ok(Math.abs(Number(ca.username.split(":")[0]) - now() - 600) <= 2);
  assert.equal(JSON.stringify(r.media).includes(process.env.TURN_STATIC_SECRET!), false);
  assert.equal((await C.client.req("call:get", { callId })).ok, false);
  assert.equal((await C.client.req("rtc:iceConfig", { callId })).ok, false);
  const acc = await B.client.req("call:accept", { callId });
  assert.ok(acc.ok, JSON.stringify(acc));
  assert.equal(acc.media.provider, "p2p");
  assert.notEqual(acc.media.iceServers[0].username, ca.username, "credential bound to participant");
  await sleep(1100);
  const refreshed = await A.client.req("rtc:iceConfig", { callId });
  assert.ok(refreshed.ok);
  const turn = refreshed.config.iceServers.find((x: any) => x.credential);
  assert.ok(Number(turn.username.split(":")[0]) > Number(ca.username.split(":")[0]));
  assert.equal(JSON.stringify(refreshed).includes(process.env.TURN_STATIC_SECRET!), false);
  assert.ok((await A.client.req("call:hangup", { callId })).ok);
  const ended = await A.client.req("call:get", { callId });
  assert.equal(ended.call.phase, "ended");
  assert.equal(ended.media, null);
  assert.equal((await A.client.req("rtc:iceConfig", { callId })).ok, false);
  assert.equal((await B.client.req("call:accept", { callId })).ok, false);
  assert.equal((await A.client.req("rc:keys:fetch", { callId })).ok, false);
});

test("missing TURN secret keeps P2P only, with no legacy media fallback", async () => {
  // Restart the fixture to discard prior live-call media caches before changing the TURN configuration.
  for (const x of [A, B, C]) x?.client.close();
  await app.close();
  const saved = process.env.TURN_STATIC_SECRET;
  delete process.env.TURN_STATIC_SECRET;
  try {
    app = await startApp();
    A = await phoneLogin(app.wsUrl, phone(), { firstName: "Ana", username: `ana_${uniq()}` });
    B = await phoneLogin(app.wsUrl, phone(), { firstName: "Ben", username: `ben_${uniq()}` });
    assert.ok((await B.client.req("dm:send", { to: id(A), text: "call me" })).ok);
    const r = await A.client.req("call:start", { peerId: id(B) });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.media.provider, "p2p");
    assert.equal(r.media.iceServers, undefined);
    assert.equal(r.media.token, "");
    assert.ok((await A.client.req("call:hangup", { callId: r.call.id })).ok);
  } finally { process.env.TURN_STATIC_SECRET = saved; }
});
