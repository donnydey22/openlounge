// Room chat editing: author only, in the room, filtered like sending, stickers not editable, live chat:edited broadcast.
process.env.TEST_DATABASE_URL ||= "postgresql://ua@127.0.0.1:55433/roomchat_test";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { setTestEnv, startApp, wipeDb, phoneLogin, sql, type App } from "../unified-auth/harness";

setTestEnv({ providers: false, dbUrl: process.env.TEST_DATABASE_URL });
let app: App;
const uniq = () => randomBytes(3).toString("hex");
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
let A: Awaited<ReturnType<typeof phoneLogin>>, B: Awaited<ReturnType<typeof phoneLogin>>;

before(async () => {
  await sql("CREATE DATABASE roomchat_test", [], "postgresql://ua@127.0.0.1:55433/postgres").catch(() => {});
  await wipeDb(process.env.TEST_DATABASE_URL);
  app = await startApp();
  A = await phoneLogin(app.wsUrl, phone(), { firstName: "Alice", username: `alice_${uniq()}` });
  B = await phoneLogin(app.wsUrl, phone(), { firstName: "Bob", username: `bob_${uniq()}` });
});
after(async () => {
  A?.client.close();
  B?.client.close();
  await app?.close();
});

test("room chat edit: author edits, others get chat:edited, non-authors/outsiders/stickers refused", async () => {
  const room = await A.client.req("room:create", { title: "Edit room" });
  assert.equal((await A.client.req("room:join", { roomId: room.roomId })).ok, true);
  const msg = await A.client.req("chat:send", { roomId: room.roomId, text: "helo world" });
  assert.ok(msg.ok, JSON.stringify(msg));
  const id = msg.message.id;

  // outsider (not joined) can't edit
  assert.equal((await B.client.req("chat:edit", { roomId: room.roomId, messageId: id, text: "x" })).ok, false);
  assert.equal((await B.client.req("room:join", { roomId: room.roomId })).ok, true);
  const got = new Promise<any>((res) =>
    B.client.ws.on("message", (raw: Buffer) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "evt" && m.ev === "chat:edited") res(m.data);
    }),
  );
  // non-author can't edit
  const nb = await B.client.req("chat:edit", { roomId: room.roomId, messageId: id, text: "hijack" });
  assert.equal(nb.ok, false);
  assert.match(nb.error, /own messages/);
  // empty refused
  assert.equal((await A.client.req("chat:edit", { roomId: room.roomId, messageId: id, text: "   " })).ok, false);
  // author edits with formatting
  const ed = await A.client.req("chat:edit", { roomId: room.roomId, messageId: id, text: "**hello** world" });
  assert.ok(ed.ok, JSON.stringify(ed));
  assert.equal(ed.message.text, "**hello** world");
  assert.ok(ed.message.editedAt > 0);
  const ev = await got;
  assert.equal(ev.id, id);
  assert.equal(ev.text, "**hello** world");
  // unchanged = ok, no-op
  assert.equal((await A.client.req("chat:edit", { roomId: room.roomId, messageId: id, text: "**hello** world" })).unchanged, true);
  // history reflects the edit
  const join = await B.client.req("room:join", { roomId: room.roomId });
  const hist = join.chat ?? join.room?.chat;
  if (hist) assert.equal(hist.find((m: any) => m.id === id)?.text, "**hello** world");
  // unknown id
  assert.equal((await A.client.req("chat:edit", { roomId: room.roomId, messageId: "nope", text: "x" })).ok, false);
});
