// Telegram-style groups over the real WebSocket API (local Postgres only): create, fan-out, permissions, invite
// links, leave/ownership, unread, typing, receipts, reports — and the old DM endpoints keep working.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import "./env";
import { setTestEnv, startApp, wipeDb, api, phoneLogin, sql, type App } from "../unified-auth/harness";

setTestEnv({ providers: false });
let app: App;
type L = Awaited<ReturnType<typeof phoneLogin>>;
let A: L, B: L, C: L, D: L, E: L;
const uniq = () => randomBytes(3).toString("hex");
const phone = () => `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const id = (x: L) => x.res.user.id as string;

function events(x: L) {
  const got: { ev: string; data: any }[] = [];
  x.client.ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "evt") got.push({ ev: m.ev, data: m.data });
  });
  return got;
}
let ev: Record<string, { ev: string; data: any }[]> = {};
let gid = "";

before(async () => {
  await wipeDb();
  app = await startApp();
  const mk = (n: string) => phoneLogin(app.wsUrl, phone(), { firstName: n, username: `${n.toLowerCase()}_${uniq()}` });
  [A, B, C, D, E] = await Promise.all(["Maya", "Ryan", "Cara", "Dan", "Eve"].map(mk));
  ev = { A: events(A), B: events(B), C: events(C), D: events(D), E: events(E) };
});
after(async () => {
  for (const x of [A, B, C, D, E]) x?.client.close();
  await app?.close();
});

test("create a group: members get the group + service messages; non-members get nothing", async () => {
  const r = await A.client.req("group:create", { title: "Weekend crew", memberIds: [id(B), id(C)], description: "plans" });
  assert.equal(r.ok, true, JSON.stringify(r));
  gid = r.group.id;
  assert.match(gid, /^g_/);
  assert.equal(r.group.myRole, "owner");
  assert.equal(r.group.memberCount, 3);
  await sleep(150);
  const svc = ev.B.filter((e) => e.ev === "dm:message" && e.data.conversationId === gid);
  assert.deepEqual(svc.map((e) => e.data.service?.type), ["created", "added"]);
  assert.match(svc[1].data.text, /Maya added Ryan and Cara/);
  assert.ok(ev.B.some((e) => e.ev === "group:update" && e.data.group.id === gid));
  assert.equal(ev.D.filter((e) => e.data?.conversationId === gid).length, 0);
});

test("messages fan out to members with conversationId; history is members-only", async () => {
  const r = await B.client.req("dm:send", { to: gid, text: "hey @" + B.res.user.username + " and @" + C.res.user.username, clientId: "c1" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.message.conversationId, gid);
  assert.equal(r.message.toId, gid);
  // retried send with the same clientId is deduped
  const again = await B.client.req("dm:send", { to: gid, text: "hey", clientId: "c1" });
  assert.equal(again.message.id, r.message.id);
  await sleep(150);
  for (const k of ["A", "C"]) assert.ok(ev[k].some((e) => e.ev === "dm:message" && e.data.id === r.message.id), k);
  assert.ok(!ev.D.some((e) => e.data?.id === r.message.id));
  const h = await A.client.req("dm:history", { peerId: gid });
  assert.equal(h.ok, true);
  assert.equal(h.group.id, gid);
  assert.equal(h.peer.name, "Weekend crew");
  assert.ok(h.messages.some((m: any) => m.id === r.message.id));
  const out = await D.client.req("dm:history", { peerId: gid });
  assert.equal(out.ok, false);
  const nope = await D.client.req("dm:send", { to: gid, text: "let me in" });
  assert.equal(nope.ok, false);
});

test("unread counts, read receipts (readerId = group) and mute", async () => {
  const before = await C.client.req("conv:list");
  const row = before.items.find((x: any) => x.id === gid);
  assert.equal(row.type, "group");
  assert.ok(row.unread >= 1);
  assert.equal(row.mentioned, true, "C was @mentioned");
  ev.B.length = 0;
  const lastId = row.lastMessage.id;
  await C.client.req("dm:read", { peerId: gid, upToMessageId: lastId });
  await sleep(100);
  const rc = ev.B.find((e) => e.ev === "dm:read-receipt");
  assert.ok(rc, "sender got a receipt");
  assert.equal(rc!.data.readerId, gid);
  const afterRead = await C.client.req("conv:list");
  assert.equal(afterRead.items.find((x: any) => x.id === gid).unread, 0);
  // muted groups don't count toward the badge total
  await A.client.req("dm:send", { to: gid, text: "one more" });
  await sleep(50);
  const t1 = (await C.client.req("conv:list")).unread;
  await C.client.req("group:mute", { id: gid, muted: true });
  const t2 = (await C.client.req("conv:list")).unread;
  assert.ok(t1 > t2, `${t1} > ${t2}`);
  await C.client.req("group:mute", { id: gid, muted: false });
});

test("typing goes to the other members only", async () => {
  for (const k of Object.keys(ev)) ev[k].length = 0;
  A.client.ws.send(JSON.stringify({ t: "evt", ev: "dm:typing", data: { to: gid } }));
  await sleep(150);
  assert.ok(ev.B.some((e) => e.ev === "conv:typing" && e.data.conversationId === gid && e.data.from === id(A)));
  assert.ok(!ev.A.some((e) => e.ev === "conv:typing"));
  assert.ok(!ev.D.some((e) => e.ev === "conv:typing"));
});

test("permissions: members can't administer; owner promotes; admins moderate within limits", async () => {
  const deny = async (x: L, evName: string, data: any) => {
    const r = await x.client.req(evName, { id: gid, ...data });
    assert.equal(r.ok, false, `${evName} should be denied: ${JSON.stringify(r)}`);
  };
  await deny(B, "group:update", { title: "hijack" });
  await deny(B, "group:addMembers", { userIds: [id(D)] });
  await deny(B, "group:removeMember", { userId: id(C) });
  await deny(B, "group:inviteCreate", {});
  const msgs = (await A.client.req("dm:history", { peerId: gid })).messages;
  const aMsg = msgs.find((m: any) => m.fromId === id(A) && !m.service);
  await deny(B, "group:pin", { messageId: aMsg.id });
  await deny(B, "group:deleteMessage", { messageId: aMsg.id });
  await deny(B, "group:setRole", { userId: id(C), role: "admin" });
  // owner makes B an admin
  const pr = await A.client.req("group:setRole", { id: gid, userId: id(B), role: "admin" });
  assert.equal(pr.ok, true);
  // admin B: edit info, add D, pin, delete A's message
  assert.equal((await B.client.req("group:update", { id: gid, title: "Weekend crew 🌊" })).ok, true);
  const add = await B.client.req("group:addMembers", { id: gid, userIds: [id(D)] });
  assert.equal(add.ok, true, JSON.stringify(add));
  assert.deepEqual(add.added, [id(D)]);
  const pin = await B.client.req("group:pin", { id: gid, messageId: aMsg.id });
  assert.equal(pin.ok, true);
  assert.equal(pin.pins[0].messageId, aMsg.id);
  // admins can't change roles, remove the owner, or remove other admins
  await deny(B, "group:setRole", { userId: id(C), role: "admin" });
  await deny(B, "group:removeMember", { userId: id(A) });
  await A.client.req("group:setRole", { id: gid, userId: id(C), role: "admin" });
  await deny(B, "group:removeMember", { userId: id(C) });
  await A.client.req("group:setRole", { id: gid, userId: id(C), role: "member" });
  const del = await B.client.req("group:deleteMessage", { id: gid, messageId: aMsg.id });
  assert.equal(del.ok, true);
  const h = await A.client.req("dm:history", { peerId: gid });
  assert.ok(!h.messages.some((m: any) => m.id === aMsg.id));
  assert.equal(h.group.pins.length, 0, "deleting unpins");
  // service messages for the changes
  const texts = h.messages.filter((m: any) => m.service).map((m: any) => m.service.type);
  for (const t of ["role", "title", "added", "pinned"]) assert.ok(texts.includes(t), t);
  // a member can delete their own message
  const own = await C.client.req("dm:send", { to: gid, text: "oops" });
  assert.equal((await C.client.req("group:deleteMessage", { id: gid, messageId: own.message.id })).ok, true);
});

test("blocked users can't add you", async () => {
  const b = await api(app.base, "/api/me/blocks", { userId: id(A), block: true }, { token: E.res.access });
  assert.equal(b.status, 200, JSON.stringify(b.data));
  const r = await A.client.req("group:addMembers", { id: gid, userIds: [id(E)] });
  assert.equal(r.ok, false);
  const c = await A.client.req("group:create", { title: "x", memberIds: [id(E)] });
  assert.equal(c.ok, true);
  assert.equal(c.group.memberCount, 1);
  assert.equal(c.refused[0].id, id(E));
  await api(app.base, "/api/me/blocks", { userId: id(A), block: false }, { token: E.res.access });
});

test("invite links: create, preview, join, member limit, expiry, revoke", async () => {
  const inv = await A.client.req("group:inviteCreate", { id: gid, maxUses: 1, expiresInSec: 3600 });
  assert.equal(inv.ok, true, JSON.stringify(inv));
  assert.match(inv.invite.url, /\/join\/[\w-]+$/);
  const token = inv.invite.token;
  const pv = await api(app.base, `/api/groups/invite/${token}`);
  assert.equal(pv.status, 200);
  assert.equal(pv.data.preview.group.id, gid);
  assert.ok(pv.data.preview.sample.length >= 3);
  const j = await E.client.req("group:join", { token });
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.equal(j.groupId, gid);
  const again = await E.client.req("group:join", { token });
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
  // the single use is spent
  await E.client.req("group:leave", { id: gid });
  const used = await E.client.req("group:join", { token });
  assert.equal(used.ok, false);
  assert.match(used.error, /limit/);
  // expiry
  const inv2 = await A.client.req("group:inviteCreate", { id: gid, expiresInSec: 60 });
  const { groups } = await import("../../server/groups");
  groups.invites.get(inv2.invite.token)!.expiresAt = Date.now() - 1;
  const exp = await E.client.req("group:join", { token: inv2.invite.token });
  assert.equal(exp.ok, false);
  assert.match(exp.error, /expired/);
  // revoke
  const inv3 = await A.client.req("group:inviteCreate", { id: gid });
  assert.equal((await A.client.req("group:inviteRevoke", { id: gid, token: inv3.invite.token })).ok, true);
  const rv = await api(app.base, `/api/groups/invite/${inv3.invite.token}`);
  assert.equal(rv.status, 404);
  assert.equal((await E.client.req("group:join", { token: inv3.invite.token })).ok, false);
  // bad options
  assert.equal((await A.client.req("group:inviteCreate", { id: gid, maxUses: 0 })).ok, false);
  const rows = await sql("SELECT count(*)::int AS n FROM conversation_invites WHERE conversation_id = $1", [gid]);
  assert.ok((rows[0] as any).n >= 3);
});

test("removed members stop receiving; owner leaving passes ownership to the longest-serving admin", async () => {
  const rm = await A.client.req("group:removeMember", { id: gid, userId: id(D) });
  assert.equal(rm.ok, true);
  await sleep(100);
  assert.ok(ev.D.some((e) => e.ev === "group:removed" && e.data.id === gid));
  ev.D.length = 0;
  await A.client.req("dm:send", { to: gid, text: "after D left" });
  await sleep(100);
  assert.ok(!ev.D.some((e) => e.ev === "dm:message"));
  const lv = await A.client.req("group:leave", { id: gid });
  assert.equal(lv.ok, true);
  const g = await B.client.req("group:get", { id: gid });
  assert.equal(g.group.myRole, "owner", "B (admin) inherits ownership");
  assert.equal(g.group.members.find((m: any) => m.id === id(A)), undefined);
  const svc = (await B.client.req("dm:history", { peerId: gid })).messages.filter((m: any) => m.service).map((m: any) => m.service.type);
  assert.ok(svc.includes("left") && svc.includes("owner"));
  const rows = await sql<{ role: string; user_id: string }>("SELECT role, user_id FROM conversation_members WHERE conversation_id = $1", [gid]);
  await sleep(200);
  assert.equal(rows.find((r) => r.user_id === id(B))?.role, "owner");
});

test("report a group lands in content_reports", async () => {
  const r = await C.client.req("group:report", { id: gid, reason: "spam", note: "test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  await sleep(1200); // store snapshot debounce
  const rows = await sql<{ target_type: string }>("SELECT target_type FROM content_reports WHERE target_id = $1", [gid]);
  assert.equal(rows[0]?.target_type, "group");
});

test("old DM endpoints are unchanged; conv:list merges DMs and groups", async () => {
  const s = await B.client.req("dm:send", { to: id(C), text: "1:1 still works" });
  assert.equal(s.ok, true);
  assert.equal(s.message.toId, id(C));
  const list = await C.client.req("dm:list");
  assert.ok(list.conversations.every((c: any) => !String(c.peer.id).startsWith("g_")), "dm:list stays 1:1 only");
  const conv = await C.client.req("conv:list");
  assert.ok(conv.items.some((x: any) => x.type === "dm" && x.id === id(B)));
  assert.ok(conv.items.some((x: any) => x.type === "group" && x.id === gid));
  await sleep(1200);
  const dm = await sql<{ type: string }>("SELECT type FROM conversations WHERE id = $1", [[id(B), id(C)].sort().join("|")]);
  assert.equal(dm[0]?.type, "dm", "new 1:1 conversations are mirrored into conversations");
  const persisted = await sql<{ conversation_id: string; to_id: string }>("SELECT conversation_id, to_id FROM dms WHERE conversation_id = $1 LIMIT 1", [gid]);
  assert.equal(persisted[0]?.to_id, gid);
});

test("group photo upload is served from /api/groups/<id>/photo", async () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const r = await B.client.req("group:update", { id: gid, photo: png });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.group.photoUrl, /\/api\/groups\/g_.+\/photo\?v=\d+/);
  const res = await fetch(app.base + r.group.photoUrl);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
});

test("in-app banner flags (notify / mention / title), conv:read on the reader's devices, group drop-in audio chat", async () => {
  const r = await A.client.req("group:create", { title: "Banner test", memberIds: [id(B), id(C)] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const g2 = r.group.id;
  assert.equal((await C.client.req("group:mute", { id: g2, muted: true })).ok, true);
  const plain = await B.client.req("dm:send", { to: g2, text: "hello all" });
  const ment = await B.client.req("dm:send", { to: g2, text: `ping @${C.res.user.username}` });
  await sleep(200);
  const at = (k: string, mid: string) => ev[k].find((e) => e.ev === "dm:message" && e.data.id === mid)?.data;
  assert.equal(at("A", plain.message.id).notify, true);
  assert.equal(at("A", plain.message.id).conversationTitle, "Banner test");
  assert.equal(at("C", plain.message.id).notify, false, "muted member: no banner");
  assert.equal(at("C", ment.message.id).notify, true, "muted member still alerted on @mention");
  assert.equal(at("C", ment.message.id).mentioned, true);
  assert.equal(at("B", plain.message.id).notify, undefined, "sender's own echo carries no banner flag");
  // reading on one device tells the reader's other devices (inbox badge clears)
  assert.equal((await C.client.req("dm:read", { peerId: g2 })).ok, true);
  await sleep(150);
  assert.ok(ev.C.some((e) => e.ev === "conv:read" && e.data.conversationId === g2));
  // drop-in audio chat inside the group: one live room per group, every member may join, card posted in the group
  const d1 = await A.client.req("dropin:start", { peerId: g2 });
  assert.equal(d1.ok, true, JSON.stringify(d1));
  await sleep(150);
  const card = ev.C.find((e) => e.ev === "dm:message" && e.data.toId === g2 && e.data.kind === "dropin")?.data;
  assert.equal(card?.roomId, d1.roomId);
  const d2 = await B.client.req("dropin:start", { peerId: g2 });
  assert.equal(d2.ok, true);
  assert.equal(d2.roomId, d1.roomId);
  assert.equal(d2.reused, true);
  const outsider = await D.client.req("dropin:start", { peerId: g2 });
  assert.equal(outsider.ok, false);
});

test("inbox actions on group rows: pin / unpin / mark read via dm:chat; leave clears the pin; non-members rejected", async () => {
  const g = await A.client.req("group:create", { title: "Pinnable " + uniq(), memberIds: [id(B)] });
  assert.equal(g.ok, true, JSON.stringify(g));
  const pg = g.group.id as string;
  await A.client.req("dm:send", { to: pg, text: "unread for Ryan" });
  await sleep(150);
  const pin = await B.client.req("dm:chat", { peerId: pg, action: "pin" });
  assert.equal(pin.ok, true, JSON.stringify(pin));
  assert.equal(pin.pinned, true);
  await sleep(100);
  assert.ok(ev.B.some((e) => e.ev === "dm:chat-state" && e.data.peerId === pg && e.data.pinned === true), "my devices hear the pin");
  let row = (await B.client.req("conv:list")).items.find((x: any) => x.id === pg);
  assert.ok(row.pinnedAt > 0, "conv:list carries pinnedAt for group rows");
  assert.ok(row.unread > 0);
  const read = await B.client.req("dm:chat", { peerId: pg, action: "read" });
  assert.equal(read.ok, true);
  await sleep(100);
  assert.ok(ev.B.some((e) => e.ev === "conv:read" && e.data.conversationId === pg));
  row = (await B.client.req("conv:list")).items.find((x: any) => x.id === pg);
  assert.equal(row.unread, 0);
  const rm = await B.client.req("dm:chat", { peerId: pg, action: "remove" });
  assert.equal(rm.ok, false, "groups are left, not hidden");
  const outsider = await C.client.req("dm:chat", { peerId: pg, action: "pin" });
  assert.equal(outsider.ok, false);
  assert.equal((await B.client.req("group:leave", { id: pg })).ok, true);
  assert.equal((await A.client.req("group:addMembers", { id: pg, userIds: [id(B)] })).ok, true);
  row = (await B.client.req("conv:list")).items.find((x: any) => x.id === pg);
  assert.ok(row && !row.pinnedAt, "a re-join starts unpinned");
});
