import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes } from "node:crypto";
import { setTestEnv, startApp, wipeDb, phoneLogin, type App } from "../unified-auth/harness";

setTestEnv({ providers: false });
type Login = Awaited<ReturnType<typeof phoneLogin>>;
let app: App;
let alice: Login;
let bob: Login;
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const username = (name: string) => `${name}_${randomBytes(3).toString("hex")}`;
const id = (user: Login) => user.res.user.id as string;

before(async () => {
  await wipeDb();
  app = await startApp();
  alice = await phoneLogin(app.wsUrl, phone(), { firstName: "Alice", username: username("alice") });
  bob = await phoneLogin(app.wsUrl, phone(), { firstName: "Bob", username: username("bob") });
});

after(async () => {
  alice?.client.close();
  bob?.client.close();
  await app?.close();
});

test("direct and group replies are server-derived, durable, and reject missing originals", async () => {
  const original = await alice.client.req("dm:send", { to: id(bob), text: "Photo and voice discussion" });
  assert.equal(original.ok, true, JSON.stringify(original));
  const reply = await bob.client.req("dm:send", { to: id(alice), text: "Got it", replyToId: original.message.id });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.deepEqual(reply.message.replyTo, {
    messageId: original.message.id,
    senderId: id(alice),
    senderName: "Alice",
    text: "Photo and voice discussion",
  });
  const history = await alice.client.req("dm:history", { peerId: id(bob) });
  assert.deepEqual(history.messages.find((message: { id: string }) => message.id === reply.message.id)?.replyTo, reply.message.replyTo);
  const forged = await bob.client.req("dm:send", { to: id(alice), text: "no", replyToId: "not-in-this-thread" });
  assert.equal(forged.ok, false);

  const group = await alice.client.req("group:create", { title: "Reply test", memberIds: [id(bob)] });
  assert.equal(group.ok, true, JSON.stringify(group));
  const groupOriginal = await alice.client.req("dm:send", { to: group.group.id, text: "A group message" });
  const groupReply = await bob.client.req("dm:send", { to: group.group.id, text: "A group reply", replyToId: groupOriginal.message.id });
  assert.equal(groupReply.ok, true, JSON.stringify(groupReply));
  assert.equal(groupReply.message.replyTo.messageId, groupOriginal.message.id);
  assert.equal(groupReply.message.replyTo.senderId, id(alice));
});

test("room chat replies reference only messages in the same joined room", async () => {
  const created = await alice.client.req("room:create", { title: "Reply room" });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal((await alice.client.req("room:join", { roomId: created.roomId })).ok, true);
  assert.equal((await bob.client.req("room:join", { roomId: created.roomId })).ok, true);
  const original = await alice.client.req("chat:send", { roomId: created.roomId, text: "Room original" });
  const reply = await bob.client.req("chat:send", { roomId: created.roomId, text: "Room reply", replyToId: original.message.id });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.message.replyTo.messageId, original.message.id);
  assert.equal(reply.message.replyTo.senderName, "Alice");
  const missing = await bob.client.req("chat:send", { roomId: created.roomId, text: "Nope", replyToId: "missing-message" });
  assert.equal(missing.ok, false);
});
