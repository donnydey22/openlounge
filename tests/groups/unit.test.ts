// GroupService unit tests with an in-memory store + repo: member limit, push rules (mute, mentions, foreground),
// ownership succession, invite rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DirectMessage, PublicUser } from "../../src/lib/types";
import { GroupService, type StoreLike } from "../../server/groups/service";
import { JsonGroupsRepo } from "../../server/groups/repo";
import { mentionHandles, serviceText } from "../../src/lib/groups";
import { conversationId } from "../../server/conversation";

function fakeStore(n: number) {
  const users = new Map<string, { id: string; name: string; username: string; color: string; isBot: boolean }>();
  for (let i = 0; i < n; i++) users.set(`u_${i}`, { id: `u_${i}`, name: `User ${i}`, username: `user${i}`, color: "#111111", isBot: false });
  const blocks = new Set<string>();
  const dms = new Map<string, DirectMessage[]>();
  const store: StoreLike & { blocks: Set<string> } = {
    users,
    dms,
    blocks,
    publicUser: (id) => {
      const u = users.get(id);
      return u ? ({ ...u, photoUrl: null, interests: [], bio: "", createdAt: 0, followers: 0, following: 0 } as PublicUser) : null;
    },
    isBlocked: (a, b) => blocks.has(`${a}>${b}`),
    isBlockedEither: (a, b) => blocks.has(`${a}>${b}`) || blocks.has(`${b}>${a}`),
    pushConversationMessage(key, msg) {
      const l = dms.get(key) ?? [];
      l.push(msg);
      dms.set(key, l);
      svc.fanout(msg);
    },
    removeConversationMessage(key, id) {
      const l = dms.get(key) ?? [];
      const i = l.findIndex((m) => m.id === id);
      if (i >= 0) l.splice(i, 1);
      return i >= 0;
    },
    saveSoon() {},
    unreadDmCount: () => 0,
  };
  const pushes: { userId: string; body: string; data: Record<string, string> }[] = [];
  const foreground = new Set<string>();
  const svc = new GroupService(store, new JsonGroupsRepo(false));
  svc.attach({ toUsers() {}, isForeground: (id) => foreground.has(id), push: (userId, m) => pushes.push({ userId, body: m.body, data: m.data }) });
  return { svc, store, pushes, foreground };
}

test("conversationId: groups are their own key; 1:1 stays order-independent", () => {
  assert.equal(conversationId("u_b", "u_a"), "u_a|u_b");
  assert.equal(conversationId("u_a", "g_x"), "g_x");
  assert.equal(conversationId("g_x", "u_a"), "g_x");
});

test("member limit: 200 including the creator", () => {
  const { svc } = fakeStore(205);
  const ids = Array.from({ length: 200 }, (_, i) => `u_${i + 1}`);
  assert.equal(svc.create("u_0", { title: "too big", memberIds: ids }).ok, false);
  const r = svc.create("u_0", { title: "max", memberIds: ids.slice(0, 199) });
  assert.equal(r.ok, true);
  const gid = (r as any).group.id;
  const add = svc.addMembers("u_0", gid, ["u_201"]);
  assert.equal(add.ok, false);
  assert.match((add as any).error, /200/);
});

test("push: muted members only hear @mentions; foreground and sender are skipped", () => {
  const { svc, pushes, foreground } = fakeStore(5);
  const gid = (svc.create("u_0", { title: "G", memberIds: ["u_1", "u_2", "u_3"] }) as any).group.id;
  pushes.length = 0;
  svc.setMuted("u_2", gid, true);
  foreground.add("u_3");
  svc.send("u_0", gid, "hello all");
  assert.deepEqual(pushes.map((p) => p.userId).sort(), ["u_1"]);
  assert.match(pushes[0].body, /^User: hello all/);
  pushes.length = 0;
  svc.send("u_0", gid, "hey @user2 look");
  assert.deepEqual(pushes.map((p) => p.userId).sort(), ["u_1", "u_2"]);
  assert.equal(pushes.find((p) => p.userId === "u_2")!.data.mention, "1");
});

test("service messages push only to their targets (\"you were added\")", () => {
  const { svc, pushes } = fakeStore(5);
  const gid = (svc.create("u_0", { title: "G", memberIds: ["u_1"] }) as any).group.id;
  pushes.length = 0;
  svc.addMembers("u_0", gid, ["u_2"]);
  assert.deepEqual(pushes.map((p) => p.userId), ["u_2"]);
});

test("ownership succession: oldest admin, else oldest member; last one out deletes the group", async () => {
  const { svc } = fakeStore(4);
  const gid = (svc.create("u_0", { title: "G", memberIds: ["u_1", "u_2"] }) as any).group.id;
  svc.setRole("u_0", gid, "u_2", "admin");
  svc.leave("u_0", gid);
  assert.equal(svc.member(gid, "u_2")!.role, "owner");
  svc.leave("u_2", gid);
  assert.equal(svc.member(gid, "u_1")!.role, "owner");
  const r = svc.leave("u_1", gid);
  assert.equal((r as any).deleted, true);
  assert.equal(svc.convs.has(gid), false);
});

test("transfer ownership: only the owner, old owner becomes admin", () => {
  const { svc } = fakeStore(3);
  const gid = (svc.create("u_0", { title: "G", memberIds: ["u_1", "u_2"] }) as any).group.id;
  assert.equal(svc.transferOwnership("u_1", gid, "u_2").ok, false);
  assert.equal(svc.transferOwnership("u_0", gid, "u_1").ok, true);
  assert.equal(svc.member(gid, "u_1")!.role, "owner");
  assert.equal(svc.member(gid, "u_0")!.role, "admin");
});

test("invite link creator blocked the joiner → refused", () => {
  const { svc, store } = fakeStore(3);
  const gid = (svc.create("u_0", { title: "G", memberIds: [] }) as any).group.id;
  const inv = (svc.createInvite("u_0", gid, {}) as any).invite;
  store.blocks.add("u_0>u_2");
  assert.equal(svc.joinByInvite("u_2", inv.token).ok, false);
  assert.equal(svc.joinByInvite("u_1", inv.token).ok, true);
});

test("validation: name required, filtered text, photo type", () => {
  const { svc } = fakeStore(2);
  assert.equal(svc.create("u_0", { title: "   " }).ok, false);
  const gid = (svc.create("u_0", { title: "ok" }) as any).group.id;
  assert.equal(svc.update("u_0", gid, { photo: "data:image/gif;base64,AAAA" }).ok, false);
  assert.equal(svc.update("u_0", gid, { title: "x".repeat(100) }).ok, true);
  assert.equal(svc.convs.get(gid)!.title.length, 64);
});

test("mentions + service text helpers", () => {
  assert.deepEqual(mentionHandles("hi @maya_1, and @ryan! email a@b.com @x"), ["maya_1", "ryan"]);
  const name = (id: string) => ({ a: "Maya", b: "Ryan", c: "Cara" })[id] ?? id;
  assert.equal(serviceText({ type: "added", actorId: "a", targetIds: ["b", "c"] }, name), "Maya added Ryan and Cara");
  assert.equal(serviceText({ type: "title", actorId: "a", value: "New" }, name, "a"), "You changed the group name to “New”");
});
