// t5450: the server logs what the push layer did with each call ring (log only; delivery unchanged).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Notifier } from "../../server/push/notifier";
import { MemoryPushRepo } from "../../server/push/repo";
import { MemorySender, type SendResult } from "../../server/push/sender";

const call = { id: "c-log-1", callerId: "u_a", video: false, expiresAt: 123, caller: { name: "Donny Dey", photoUrl: null } };
function mk() {
  const repo = new MemoryPushRepo();
  const sender = new MemorySender();
  const n = new Notifier({ repo, sender, isForeground: () => false, userName: () => "Donny Dey", followerIds: () => [], followingIds: () => [], usersWithPhones: () => [] });
  return { n, sender };
}

test("callIncoming reports the per-device send result (platform + message id / error), never the token", async () => {
  const { n, sender } = mk();
  await n.registerToken("u_b", "tok-android-0123456789abcdef0123", "android");
  await n.registerToken("u_b", "tok-dead-0123456789abcdef012345", "web");
  sender.invalid.add("tok-dead-0123456789abcdef012345");
  let got: SendResult | null = null;
  assert.equal(await n.callIncoming("u_b", call, { onSend: (r) => (got = r) }), "sent");
  assert.ok(got);
  const r = got as SendResult;
  assert.equal(r.results?.length, 2);
  const a = r.results!.find((x) => x.platform === "android")!;
  assert.equal(a.ok, true);
  assert.ok(a.messageId);
  const w = r.results!.find((x) => x.platform === "web")!;
  assert.equal(w.ok, false);
  assert.equal(w.error, "messaging/registration-token-not-registered");
  assert.ok(!JSON.stringify(r.results).includes("tok-"));
});

test("no tokens: outcome is no-tokens and the send hook is not called (behaviour unchanged)", async () => {
  const { n, sender } = mk();
  let called = false;
  assert.equal(await n.callIncoming("u_b", call, { onSend: () => (called = true) }), "no-tokens");
  assert.equal(called, false);
  assert.equal(sender.sent.length, 0);
});

test("a throwing log hook never breaks delivery", async () => {
  const { n, sender } = mk();
  await n.registerToken("u_b", "tok-android-0123456789abcdef0123", "android");
  assert.equal(await n.callIncoming("u_b", call, { onSend: () => { throw new Error("boom"); } }), "sent");
  assert.equal(sender.sent.length, 1);
});

test("logCallPush logs outcome + devices and returns the outcome", async () => {
  const { logCallPush } = await import("../../server/calls/index");
  assert.equal(await logCallPush("incoming", "c-log-2", Date.now(), 0, Promise.resolve("sent")), "sent");
  assert.equal(await logCallPush("repush", "c-log-3", Date.now(), null, undefined), "push-disabled");
  assert.match(await logCallPush("repush", "c-log-4", Date.now(), null, Promise.reject(new Error("fcm down"))), /^error:fcm down/);
});
