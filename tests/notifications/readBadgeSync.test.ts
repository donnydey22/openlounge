import assert from "node:assert/strict";
import test from "node:test";
import { Notifier } from "../../server/push/notifier";
import { MemoryPushRepo } from "../../server/push/repo";
import { MemorySender } from "../../server/push/sender";

function latest(sender: MemorySender) {
  const sent = sender.sent.at(-1);
  assert.ok(sent, "read reconciliation must send to every registered device");
  return sent.msg;
}

test("a read receipt sends a collapsed clear with the authoritative badge total", async () => {
  const repo = new MemoryPushRepo();
  const sender = new MemorySender();
  const notifications = new Notifier({
    repo,
    sender,
    isForeground: () => false,
    userName: () => null,
    followerIds: () => [],
    followingIds: () => [],
    usersWithPhones: () => [],
    badgeCount: () => 2,
    now: () => 1_790_000_000_123,
  });
  await notifications.registerToken("u_reader", "android-token-0123456789abcdef012345", "android");
  await notifications.registerToken("u_reader", "ios-token-0123456789abcdef012345678", "ios");

  await notifications.dmRead("u_reader", "u_maya");
  const message = latest(sender);
  assert.equal(message.type, "clear");
  assert.equal(message.tag, "dm:u_maya");
  assert.equal(message.clear, true);
  assert.equal(message.badge, 2);
  assert.deepEqual(message.data, { sentAt: "1790000000123", badge: "2" });
  assert.equal(sender.sent.at(-1)?.tokens.length, 2, "all registered Android/iOS devices receive the same reconciliation");
});
