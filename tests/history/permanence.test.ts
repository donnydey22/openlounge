// Message permanence (Donny's rule, 2026-10-23): every message that is not self-destructing is kept forever,
// WhatsApp-style. 5,000+ messages in a DM, a group and a room survive a restart with message #1 fetchable; only
// delete-for-everyone (placeholder for all), self-destruct and account deletion remove content. Local Postgres only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import "./env";
import { setTestEnv, startApp, wipeDb, phoneLogin, sql, type App } from "../unified-auth/harness";

setTestEnv({ providers: false });
let app: App;
type L = Awaited<ReturnType<typeof phoneLogin>>;
let A: L, B: L, C: L;
const phones: string[] = [];
const N = 5000;
const uniq = () => randomBytes(3).toString("hex");
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const id = (x: L) => x.res.user.id as string;
const DELETED = "This message was deleted";

before(async () => {
  await wipeDb();
  app = await startApp();
  const mk = (n: string) => {
    const p = phone();
    phones.push(p);
    return phoneLogin(app.wsUrl, p, { firstName: n, username: `${n.toLowerCase()}_${uniq()}` });
  };
  A = await mk("Maya");
  B = await mk("Ryan");
  C = await mk("Cara");
});
after(async () => {
  for (const x of [A, B, C]) x?.client.close();
  await app?.close();
});

const reboot = (args: object) => {
  const out = execFileSync(process.execPath, ["--import", "tsx", "tests/history/permanence-boot.ts", JSON.stringify(args)], { env: process.env, encoding: "utf8", maxBuffer: 64 << 20 });
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  assert.ok(line, out.slice(-2000));
  return JSON.parse(line!.slice(7));
};

test("5,000+ messages in a DM, a group and a room: restart keeps all, #1 fetchable; delete-for-everyone = placeholder for all", { timeout: 240_000 }, async () => {
  const { store } = await import("../../server/store");
  const a = id(A), b = id(B), c = id(C);
  const dmKey = [a, b].sort().join("|");
  const t0 = Date.now() - N * 1000 - 3_600_000;
  const seed = (key: string, to: (from: string) => string, people: string[]) => {
    const list = [];
    for (let i = 1; i <= N; i++) {
      const from = people[i % people.length];
      list.push({ id: `${key.slice(0, 6)}-${String(i).padStart(6, "0")}`, fromId: from, fromName: "x", fromColor: "#888", toId: to(from), text: `#${i}`, createdAt: t0 + i * 1000, readAt: t0 + i * 1000 });
    }
    return list;
  };
  store.dms.set(dmKey, seed("dmseed", (f) => (f === a ? b : a), [a, b]) as never);

  const g = await A.client.req("group:create", { title: "Perm " + uniq(), memberIds: [b, c] });
  assert.equal(g.ok, true, JSON.stringify(g));
  const gid = g.group.id as string;
  const existing = store.dms.get(gid) ?? [];
  store.dms.set(gid, [...seed("grseed", () => gid, [a, b, c]), ...existing] as never);
  store.saveSoon();
  await store.flush();

  const room = await A.client.req("room:create", { title: "Perm room " + uniq() });
  const roomId = room.roomId as string;
  assert.equal((await A.client.req("room:join", { roomId })).ok, true);
  const rec = store.rooms.get(roomId)!;
  for (let i = 1; i <= N; i++)
    store.permanence.addRoomMessage({ id: `rmseed-${String(i).padStart(6, "0")}`, roomId, authorId: a, authorName: "Maya", authorColor: "#888", authorPhotoUrl: null, authorRole: "host", authorIsBot: false, text: `#${i}`, createdAt: t0 + i * 1000 });
  assert.equal(rec.chat.length, N, "room.chat is the permanent log (no 200 cap)");

  // live sends on top
  assert.equal((await A.client.req("dm:send", { to: b, text: "dm live", clientId: "p-1" })).ok, true);
  const dmDel = await A.client.req("dm:send", { to: b, text: "dm secret", clientId: "p-2" });
  const dmHide = await B.client.req("dm:send", { to: a, text: "hide me only", clientId: "p-3" });
  const gDel = await B.client.req("dm:send", { to: gid, text: "group secret", clientId: "p-4" });
  for (let i = 0; i < 3; i++) assert.equal((await A.client.req("chat:send", { roomId, text: `room live ${i}` })).ok, true);
  const rDel = await A.client.req("chat:send", { roomId, text: "room secret" });

  // deletes
  assert.equal((await A.client.req("dm:delete", { peerId: b, messageIds: [dmDel.message.id], forEveryone: true })).ok, true);
  assert.equal((await A.client.req("dm:delete", { peerId: b, messageIds: [dmHide.message.id], forEveryone: false })).ok, true);
  assert.equal((await B.client.req("group:deleteMessage", { id: gid, messageId: gDel.message.id })).ok, true);
  assert.equal((await A.client.req("chat:delete", { roomId, messageId: rDel.message.id })).ok, true);

  // content gone, archive unchanged, placeholder rows stored
  await store.flush();
  await store.permanence.drain();
  assert.equal((await sql("SELECT 1 FROM dms WHERE id = $1", [dmDel.message.id])).length, 0, "content row leaves dms");
  assert.equal((await sql("SELECT 1 FROM dm_deleted WHERE message_id = $1", [dmDel.message.id])).length, 1, "30-day moderation archive unchanged");
  assert.equal((await sql("SELECT 1 FROM message_tombstones WHERE message_id = ANY($1)", [[dmDel.message.id, gDel.message.id]])).length, 2);
  const [rr] = await sql<{ data: { text: string; deleted: boolean } }>("SELECT data FROM room_messages WHERE id = $1", [rDel.message.id]);
  assert.equal(rr.data.text, DELETED);
  assert.equal(rr.data.deleted, true);
  assert.equal((await sql("SELECT 1 FROM room_messages WHERE room_id = $1 AND data->>'text' = 'room secret'", [roomId])).length, 0, "room content scrubbed");

  // edits / reactions / replies refused on a placeholder
  assert.equal((await A.client.req("dm:send", { to: b, text: "re", replyToId: dmDel.message.id })).ok, false);
  assert.equal((await A.client.req("chat:edit", { roomId, messageId: rDel.message.id, text: "back" })).ok, false);

  // second device / reinstall (fresh sign-in, empty phone cache): same full history incl. the placeholder, back to #1
  const B2 = await phoneLogin(app.wsUrl, phones[1]);
  assert.equal(B2.res.user.id, b, "same account");
  let cursor: string | undefined, all: { id: string; text: string; deleted?: boolean }[] = [];
  for (;;) {
    const h = await B2.client.req("dm:history", { peerId: a, limit: 200, ...(cursor ? { beforeId: cursor } : {}) });
    assert.equal(h.ok, true);
    all = [...h.messages, ...all];
    if (!h.hasMore) break;
    cursor = h.messages[0].id;
  }
  assert.equal(all[0].text, "#1");
  assert.equal(all.length, N + 3);
  assert.equal(all.find((m) => m.id === dmDel.message.id)?.deleted, true);
  const gh = await C.client.req("dm:history", { peerId: gid, limit: 200 });
  assert.equal(gh.messages.find((m: { id: string }) => m.id === gDel.message.id)?.text, DELETED, "every group member sees the placeholder");
  B2.client.close();
  const rp = await B.client.req("chat:history", { roomId, limit: 5 });
  assert.equal(rp.ok, true, "a public room's chat is readable like joining it");
  assert.equal(rp.messages.length, 5);

  // room ends: chat stays
  await A.client.req("room:end", { roomId });

  const r = reboot({ a, b, dmKey, gid, roomId });
  assert.equal(r.dmA.first, "#1");
  assert.equal(r.dmB.first, "#1");
  assert.equal(r.dmA.n, N + 3 - 1, "deleter's view: all + live + placeholder, minus the one A hid for itself");
  assert.equal(r.dmB.n, N + 3, "peer still sees the delete-for-me message");
  assert.deepEqual(r.dmA.deleted, [dmDel.message.id]);
  assert.deepEqual(r.dmB.deleted, [dmDel.message.id]);
  assert.equal(r.dmB.texts[dmDel.message.id], DELETED);
  assert.equal(r.group.first, "#1");
  assert.ok(r.group.n >= N + 1);
  assert.deepEqual(r.group.deleted, [gDel.message.id]);
  assert.equal(r.room.first, "#1");
  assert.equal(r.room.n, N + 4);
  assert.deepEqual(r.room.deleted, [rDel.message.id]);
});

test("only delete-for-everyone, self-destruct and account deletion can remove message content (source invariants)", () => {
  const store = readFileSync("server/store.ts", "utf8");
  const pgs = readFileSync("server/pg.ts", "utf8");
  const groups = readFileSync("server/groups/service.ts", "utf8");
  assert.doesNotMatch(store, /DM_HISTORY_PER_CONVERSATION|room\.chat\.splice|room\.chat = \[\]/);
  assert.doesNotMatch(groups, /HISTORY_CAP/);
  assert.doesNotMatch(store, /list\.splice\(0,/);
  assert.equal((pgs.match(/DELETE FROM dms\b/g) ?? []).length, 1, "the snapshot diff is the only dms delete");
  assert.match(store, /removeConversationMessage[\s\S]{0,900}addTombstone/, "delete for everyone leaves a placeholder");
  const perm = readFileSync("server/permanence.ts", "utf8");
  assert.doesNotMatch(perm, /DELETE FROM/);
  const mig = readFileSync("server/migrations/034_message_permanence.sql", "utf8");
  assert.doesNotMatch(mig, /\b(DROP|DELETE|TRUNCATE|ALTER)\b/i, "034 is add-only");
});

test("group media survives the last member leaving unless it self-destructs", () => {
  const media = readFileSync("server/media/service.ts", "utf8");
  assert.match(media, /async purgeConversation[\s\S]{0,900}r\.viewOnce \|\| r\.ttlSeconds \|\| r\.expiresAt/);
});

test("phone never drops message rows; placeholders replace rows; room chat pages to #1", () => {
  const ms = readFileSync("src/lib/chat/msgStore.ts", "utf8");
  assert.doesNotMatch(ms, /\.delete\(|\.clear\(/);
  assert.match(ms, /old\?\.gone && !\(m as \{ deleted\?: boolean \}\)\.deleted/);
  const thread = readFileSync("src/components/chat/DmThread.tsx", "utf8");
  assert.match(thread, /msg-deleted-placeholder/);
  assert.match(thread, /showPlaceholder\(d\.placeholder\)/);
  const prov = readFileSync("src/components/room/LiveRoomProvider.tsx", "utf8");
  assert.doesNotMatch(prov, /slice\(-ROOM_CHAT_HISTORY\)/);
  assert.match(prov, /"chat:history"/);
  assert.match(readFileSync("src/components/chat/RoomChatPanel.tsx", "utf8"), /msg-deleted-placeholder/);
});
