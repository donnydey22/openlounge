// Push for room invite / drop-in cards: opens the room itself, honours foreground + the roomInvite preference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Notifier } from "../../server/push/notifier";
import { MemoryPushRepo } from "../../server/push/repo";
import { MemorySender } from "../../server/push/sender";

function mk(foreground = false) {
  const repo = new MemoryPushRepo();
  const sender = new MemorySender();
  const n = new Notifier({
    repo,
    sender,
    isForeground: () => foreground,
    userName: (id) => (id === "u_a" ? "Donny Dey" : "Bea"),
    followerIds: () => [],
    followingIds: () => [],
    usersWithPhones: () => [],
  });
  return { n, repo, sender };
}

test("room invite card push deep-links into the room", async () => {
  const { n, sender } = mk();
  await n.registerToken("u_b", "tok-b-0123456789abcdef0123456789", "android");
  const out = await n.roomInviteDm("r1", "Late night builders", "u_a", "u_b", "room_invite");
  assert.equal(out, "sent");
  const sent = (sender as any).sent ?? (sender as any).log ?? (sender as any).messages;
  const msg = Array.isArray(sent) ? sent[sent.length - 1] : null;
  assert.ok(msg, "recorded");
  const m = msg.msg ?? msg.message ?? msg;
  assert.equal(m.url, "/room/r1");
  assert.match(m.title, /Donny Dey invited you/);
  assert.match(m.body, /Late night builders/);
});

test("drop-in push says who is live; skipped while the app is in the foreground", async () => {
  const a = mk();
  await a.n.registerToken("u_b", "tok-b-0123456789abcdef0123456789", "ios");
  assert.equal(await a.n.roomInviteDm("r2", "Donny & Bea", "u_a", "u_b", "dropin"), "sent");
  const b = mk(true);
  await b.n.registerToken("u_b", "tok-b-0123456789abcdef0123456789", "ios");
  assert.equal(await b.n.roomInviteDm("r2", "Donny & Bea", "u_a", "u_b", "dropin"), "skip:foreground");
});

test("respects the roomInvite notification preference", async () => {
  const { n } = mk();
  await n.registerToken("u_b", "tok-b-0123456789abcdef0123456789", "android");
  await n.updatePrefs("u_b", { roomInvite: false });
  const out = await n.roomInviteDm("r3", "x", "u_a", "u_b", "room_invite");
  assert.notEqual(out, "sent");
});
