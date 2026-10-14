import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes } from "node:crypto";
import { setTestEnv, startApp, wipeDb, phoneLogin, wsClient, type App } from "../unified-auth/harness";

setTestEnv({ providers: false });

type Login = Awaited<ReturnType<typeof phoneLogin>>;
type Event = { ev: string; data: Record<string, unknown> };

let app: App;
let sender: Login;
let reader: Login;
let readerSecondSession: ReturnType<typeof wsClient>;
let readerEvents: Event[];
let secondSessionEvents: Event[];

const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const username = (prefix: string) => `${prefix}_${randomBytes(3).toString("hex")}`;
const userId = (login: Login) => login.res.user.id as string;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function collect(ws: { on(event: "message", listener: (raw: Buffer) => void): unknown }): Event[] {
  const events: Event[] = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as { t?: string; ev?: string; data?: Record<string, unknown> };
    if (message.t === "evt" && message.ev && message.data) events.push({ ev: message.ev, data: message.data });
  });
  return events;
}

async function waitFor<T>(find: () => T | undefined, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = find();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for WebSocket event");
    await sleep(20);
  }
}

before(async () => {
  await wipeDb();
  app = await startApp();
  sender = await phoneLogin(app.wsUrl, phone(), { firstName: "Sender", username: username("sender") });
  reader = await phoneLogin(app.wsUrl, phone(), { firstName: "Reader", username: username("reader") });
  readerSecondSession = wsClient(app.wsUrl);
  await readerSecondSession.open;
  const resumed = await readerSecondSession.req("session:resume", { token: reader.res.access ?? reader.res.refresh ?? reader.res.token });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  readerEvents = collect(reader.client.ws);
  secondSessionEvents = collect(readerSecondSession.ws);
});

after(async () => {
  readerSecondSession?.close();
  sender?.client.close();
  reader?.client.close();
  await app?.close();
});

test("reading a DM clears the same row and total on every reader session", async () => {
  const senderId = userId(sender);
  const readerId = userId(reader);

  const first = await sender.client.req("dm:send", { to: readerId, text: "first unread" });
  const second = await sender.client.req("dm:send", { to: readerId, text: "second unread" });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(second.ok, true, JSON.stringify(second));

  await waitFor(() => readerEvents.find((event) => event.ev === "dm:unread" && event.data.count === 2));
  const before = await reader.client.req("dm:list", {});
  const beforeRow = before.conversations.find((conversation: { peer: { id: string } }) => conversation.peer.id === senderId);
  assert.equal(before.unread, 2);
  assert.equal(beforeRow?.unread, 2);

  readerEvents.length = 0;
  secondSessionEvents.length = 0;
  const read = await readerSecondSession.req("dm:read", { peerId: senderId, upToMessageId: second.message.id });
  assert.equal(read.ok, true, JSON.stringify(read));

  for (const events of [readerEvents, secondSessionEvents]) {
    const receipt = await waitFor(() => events.find((event) => event.ev === "dm:read-receipt"));
    assert.equal(receipt.data.readerId, readerId);
    assert.equal(receipt.data.peerId, senderId);
    assert.equal(receipt.data.upToMessageId, second.message.id);
    const readState = await waitFor(() => events.find((event) => event.ev === "dm:read-state"));
    assert.deepEqual(readState.data, { peerId: senderId, unread: 0, total: 0 }, "the exact direct-row state reaches every reader session");
    const unread = await waitFor(() => events.find((event) => event.ev === "dm:unread"));
    assert.equal(unread.data.count, 0, "the shared native/header badge total is cleared");
  }

  const afterFirstSession = await reader.client.req("dm:list", {});
  const afterSecondSession = await readerSecondSession.req("dm:list", {});
  for (const inbox of [afterFirstSession, afterSecondSession]) {
    const row = inbox.conversations.find((conversation: { peer: { id: string } }) => conversation.peer.id === senderId);
    assert.equal(inbox.unread, 0);
    assert.equal(row?.unread, 0, "the conversation-row source of truth is clear");
  }
});

test("a read receipt reports the exact row count when a newer DM remains unseen", async () => {
  const senderId = userId(sender);
  const readerId = userId(reader);
  const first = await sender.client.req("dm:send", { to: readerId, text: "seen before a race" });
  const newer = await sender.client.req("dm:send", { to: readerId, text: "newer unread race" });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(newer.ok, true, JSON.stringify(newer));

  readerEvents.length = 0;
  const read = await readerSecondSession.req("dm:read", { peerId: senderId, upToMessageId: first.message.id });
  assert.equal(read.ok, true, JSON.stringify(read));
  const state = await waitFor(() => readerEvents.find((event) => event.ev === "dm:read-state"));
  assert.deepEqual(state.data, { peerId: senderId, unread: 1, total: 1 });
  const inbox = await reader.client.req("dm:list", {});
  const row = inbox.conversations.find((conversation: { peer: { id: string } }) => conversation.peer.id === senderId);
  assert.equal(inbox.unread, 1);
  assert.equal(row?.unread, 1, "a race cannot cause the browser to hide the newer message");
});
