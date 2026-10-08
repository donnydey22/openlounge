// Inbound LiveKit webhooks: signature (JWT + body sha256) verified, replays dropped, events fanned out.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
process.env.LIVEKIT_API_KEY = "devkey";
process.env.LIVEKIT_API_SECRET = "webhook-test-secret-0123456789abcdef";
import { AccessToken } from "livekit-server-sdk";
type WH = typeof import("../../server/livekitWebhook");
let handleLiveKitWebhook: WH["handleLiveKitWebhook"], onLiveKitEvent: WH["onLiveKitEvent"], recentLiveKitEvents: WH["recentLiveKitEvents"];
let server: http.Server;
let url = "";
before(async () => {
  ({ handleLiveKitWebhook, onLiveKitEvent, recentLiveKitEvents } = await import("../../server/livekitWebhook"));
  server = http.createServer((req, res) => void handleLiveKitWebhook(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/livekit/webhook`;
});

async function sign(body: string, secret = process.env.LIVEKIT_API_SECRET!) {
  const at = new AccessToken("devkey", secret);
  at.sha256 = createHash("sha256").update(body).digest("base64");
  return at.toJwt();
}
const post = async (body: string, auth?: string) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/webhook+json", ...(auth ? { Authorization: auth } : {}) }, body });

const event = (id: string, kind = "participant_joined") =>
  JSON.stringify({ id, event: kind, createdAt: String(Math.floor(Date.now() / 1000)), room: { sid: "RM_x", name: "openlounge-ab12cd34" }, participant: { sid: "PA_x", identity: "u_1" } });

test("valid signed event is accepted and delivered to subscribers", async () => {
  const got: string[] = [];
  const off = onLiveKitEvent((ev) => void got.push(`${ev.event}:${ev.room?.name}`));
  const body = event("EV_1");
  const r = await post(body, await sign(body));
  assert.equal(r.status, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(got, ["participant_joined:openlounge-ab12cd34"]);
  assert.equal(recentLiveKitEvents.at(-1)?.id, "EV_1");
  off();
});

test("replayed event id is acknowledged but not re-delivered", async () => {
  let n = 0;
  const off = onLiveKitEvent(() => void n++);
  const body = event("EV_1");
  const r = await post(body, await sign(body));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).duplicate, true);
  assert.equal(n, 0);
  off();
});

test("missing / wrong-secret / tampered-body signatures are rejected", async () => {
  const body = event("EV_2", "room_finished");
  assert.equal((await post(body)).status, 401);
  assert.equal((await post(body, await sign(body, "some-other-secret-0123456789abcdef"))).status, 401);
  const sig = await sign(body);
  assert.equal((await post(body.replace("u_1", "u_2"), sig)).status, 401);
});

test("oversized bodies are refused", async () => {
  const big = "x".repeat(70 * 1024);
  const r = await post(big, await sign(big)).catch(() => null);
  assert.ok(!r || r.status === 413);
  server.close();
});
