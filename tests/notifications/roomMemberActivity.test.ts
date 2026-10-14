// Public-room member activity: exact existing-seat fan-out, reconnect suppression, durable host-start audience, and
// private drop-in non-disclosure. Uses the real WebSocket handlers with the in-memory push sender as an observation point.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTestEnv, startApp, wipeDb, phoneLogin, wsClient, type App } from "../unified-auth/harness";
import { initPush } from "../../server/push";
import { MemoryPushRepo } from "../../server/push/repo";
import { MemorySender } from "../../server/push/sender";

const DB = process.env.TEST_DATABASE_URL || "postgresql://ua@127.0.0.1:55433/room_notifications_integration";
setTestEnv({ providers: false, dbUrl: DB });

type Login = Awaited<ReturnType<typeof phoneLogin>>;
type PushLog = { tokens: { userId: string }[]; msg: { type: string; title: string; url: string } };

const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const uid = (x: Login) => x.res.user.id as string;

async function waitFor<T>(read: () => T | undefined, ms = 3000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error("timed out waiting for push delivery");
    await sleep(20);
  }
}

let app: App;
let host: Login, seated: Login, joiner: Login;
let sender: MemorySender;
let extraClient: ReturnType<typeof wsClient> | null = null;

before(async () => {
  await wipeDb(DB);
  app = await startApp();
  sender = new MemorySender();
  const notifier = initPush({ repo: new MemoryPushRepo(), sender });
  host = await phoneLogin(app.wsUrl, phone(), { firstName: "Host", username: `host_${randomBytes(3).toString("hex")}` });
  seated = await phoneLogin(app.wsUrl, phone(), { firstName: "Seated", username: `seated_${randomBytes(3).toString("hex")}` });
  joiner = await phoneLogin(app.wsUrl, phone(), { firstName: "Joiner", username: `joiner_${randomBytes(3).toString("hex")}` });
  for (const [id, suffix] of [[uid(host), "host"], [uid(seated), "seated"], [uid(joiner), "joiner"]] as const)
    assert.equal((await notifier.registerToken(id, `room-activity-${suffix}-${"x".repeat(24)}`, "android")).ok, true);
});

after(async () => {
  extraClient?.close();
  host?.client.close();
  seated?.client.close();
  joiner?.client.close();
  await app?.close();
});

test("public room membership fans out exactly once and is retained for the host's next live room", async () => {
  const made = await host.client.req("room:create", { title: "Public activity" });
  assert.ok(made.ok, JSON.stringify(made));
  const roomId = made.roomId as string;

  assert.ok((await host.client.req("room:join", { roomId })).ok);
  assert.ok((await host.client.req("presence:visible", { visible: false })).ok);
  await sleep(50);
  sender.sent.length = 0;

  assert.ok((await seated.client.req("room:join", { roomId })).ok);
  assert.ok((await seated.client.req("presence:visible", { visible: false })).ok);
  const seatedJoin = await waitFor(() => (sender.sent as PushLog[]).find((entry) => entry.tokens.some((t) => t.userId === uid(host)) && entry.msg.type === "roomMemberActivity"));
  assert.match(seatedJoin.msg.title, /Seated joined/);
  assert.equal(seatedJoin.msg.url, `/room/${roomId}`);

  sender.sent.length = 0;
  assert.ok((await joiner.client.req("room:join", { roomId })).ok);
  assert.ok((await joiner.client.req("presence:visible", { visible: false })).ok);
  await waitFor(() => {
    const recipients = new Set(
      (sender.sent as PushLog[])
        .filter((entry) => entry.msg.type === "roomMemberActivity" && /Joiner joined/.test(entry.msg.title))
        .flatMap((entry) => entry.tokens.map((token) => token.userId)),
    );
    return recipients.has(uid(host)) && recipients.has(uid(seated)) ? recipients : undefined;
  });

  // A second device claims the already-existing seat. It must not make everyone hear a duplicate "Seated joined".
  sender.sent.length = 0;
  extraClient = wsClient(app.wsUrl);
  await extraClient.open;
  const resumed = await extraClient.req("session:resume", { token: seated.res.access });
  assert.ok(resumed.ok, JSON.stringify(resumed));
  assert.ok((await extraClient.req("presence:visible", { visible: false })).ok);
  assert.ok((await extraClient.req("room:join", { roomId })).ok);
  await sleep(120);
  assert.equal((sender.sent as PushLog[]).filter((entry) => /Seated joined/.test(entry.msg.title)).length, 0);

  // Starting another public room from the same host reaches members who explicitly joined the earlier public room.
  sender.sent.length = 0;
  const next = await host.client.req("room:create", { title: "Host's next room" });
  assert.ok(next.ok, JSON.stringify(next));
  assert.ok((await host.client.req("room:join", { roomId: next.roomId })).ok);
  await waitFor(() => {
    const recipients = new Set(
      (sender.sent as PushLog[])
        .filter((entry) => entry.msg.type === "roomMemberActivity" && /Host started a room/.test(entry.msg.title))
        .flatMap((entry) => entry.tokens.map((token) => token.userId)),
    );
    return recipients.has(uid(seated)) && recipients.has(uid(joiner)) ? recipients : undefined;
  });
});

test("private drop-ins do not create public room-activity notifications", async () => {
  sender.sent.length = 0;
  const started = await host.client.req("dropin:start", { peerId: uid(seated) });
  assert.ok(started.ok, JSON.stringify(started));
  assert.ok((await host.client.req("room:join", { roomId: started.roomId })).ok);
  assert.ok((await seated.client.req("room:join", { roomId: started.roomId })).ok);
  await sleep(160);
  assert.equal((sender.sent as PushLog[]).filter((entry) => entry.msg.type === "roomMemberActivity").length, 0);
});
