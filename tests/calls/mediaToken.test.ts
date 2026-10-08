// The call's media credential (its LiveKit join token) is short-lived and dies with the call:
//   - minted at ring time with CALL_TOKEN_TTL_S (180 s in prod, 6 s here), scoped to the call's own room + identity
//   - call:get / call:accept re-mint once a token is past half its life — only while the call is live
//   - after hang-up nothing is handed out, and a join into the ended call's LiveKit room (webhook) is kicked
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { fakeLiveKit, listenFakeLiveKit, twirp } from "./media-env";
import "./env";
import { AccessToken } from "livekit-server-sdk";
import { setTestEnv, startApp, wipeDb, phoneLogin, type App } from "../unified-auth/harness";

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

test("call tokens: short-lived, per call + per person, re-minted while live, never after the call ends; ended-call joins are kicked", async () => {
  const r = await A.client.req("call:start", { peerId: id(B) });
  assert.ok(r.ok, JSON.stringify(r));
  const callId = r.call.id as string;
  const room = `openlounge-call-${callId}`;
  const ta = jwt(r.media.token);
  // minted at ring, lifetime = CALL_TOKEN_TTL_S, scoped to this call's room and the caller's identity
  assert.equal(ta.video.room, room);
  assert.equal(ta.sub, id(A));
  assert.ok(Math.abs(ta.exp - now() - 6) <= 2, `exp in ${ta.exp - now()} s`);

  // a stranger can't get media for someone else's call
  const g0 = await C.client.req("call:get", { callId });
  assert.ok(!g0.ok || !g0.media, "non-participant got media");

  const acc = await B.client.req("call:accept", { callId });
  assert.ok(acc.ok, JSON.stringify(acc));
  const tb = jwt(acc.media.token);
  assert.equal(tb.sub, id(B));
  assert.equal(tb.video.room, room);

  // a live participant joining its own call room is fine
  let t0 = Date.now();
  assert.equal(await webhook("participant_joined", room, id(B)), 200);
  await sleep(300);
  assert.equal(kicks(room, t0).length, 0, "live call participant was kicked");

  // past half the lifetime, our rejoin path (call:get) hands out a FRESH token
  await sleep(3500);
  const g1 = await A.client.req("call:get", { callId });
  assert.ok(g1.ok && g1.media, JSON.stringify(g1));
  const ta2 = jwt(g1.media.token);
  assert.ok(ta2.exp > ta.exp, "rejoin token not re-minted");
  assert.ok(Math.abs(ta2.exp - now() - 6) <= 2);

  // hang up → the credential dies with the call
  assert.ok((await A.client.req("call:hangup", { callId })).ok);
  const g2 = await A.client.req("call:get", { callId });
  assert.equal(g2.call?.phase ?? "ended", "ended");
  assert.equal(g2.media ?? null, null, "media handed out for an ended call");
  const acc2 = await B.client.req("call:accept", { callId });
  assert.ok(!acc2.ok || !acc2.media, "accept on an ended call returned media");
  const again = await A.client.req("call:start", { peerId: id(B) });
  if (again.ok) {
    assert.notEqual(again.call.id, callId, "a new call must get a new room");
    assert.notEqual(jwt(again.media.token).video.room, room);
    assert.ok((await A.client.req("call:hangup", { callId: again.call.id })).ok);
  }

  // someone still holding a valid (LiveKit-refreshed) token joins the ended call's room → removed + room closed
  t0 = Date.now();
  assert.equal(await webhook("participant_joined", room, id(B)), 200);
  for (let i = 0; i < 40 && kicks(room, t0).length < 2; i++) await sleep(50);
  const k = kicks(room, t0);
  assert.ok(k.some((x) => x.path.endsWith("/RemoveParticipant") && x.body.identity === id(B)), JSON.stringify(k));
  assert.ok(k.some((x) => x.path.endsWith("/DeleteRoom")), JSON.stringify(k));

  // a forged (unsigned) webhook is rejected and kicks nobody
  t0 = Date.now();
  const forged = await fetch(`${app.base}/api/livekit/webhook`, { method: "POST", headers: { Authorization: "x" }, body: JSON.stringify({ event: "participant_joined", room: { name: room }, participant: { identity: id(A) } }) });
  assert.equal(forged.status, 401);
  // unknown call ids (e.g. after an app-server restart) are left alone
  const unknown = `openlounge-call-${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`;
  assert.equal(await webhook("participant_joined", unknown, id(A)), 200);
  await sleep(300);
  assert.equal(kicks(room, t0).length + kicks(unknown, t0).length, 0);
});
