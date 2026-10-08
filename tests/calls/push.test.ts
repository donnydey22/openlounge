// Call pushes: ringing data message (wrappers' full-screen UI), cancel, and "Missed call · Call back".
import { test } from "node:test";
import assert from "node:assert/strict";
import { Notifier } from "../../server/push/notifier";
import { MemoryPushRepo } from "../../server/push/repo";
import { MemorySender } from "../../server/push/sender";

function mk(foreground = false) {
  const repo = new MemoryPushRepo();
  const sender = new MemorySender();
  const n = new Notifier({ repo, sender, isForeground: () => foreground, userName: () => "Donny Dey", followerIds: () => [], followingIds: () => [], usersWithPhones: () => [] });
  return { n, sender };
}
const last = (sender: any) => {
  const sent = sender.sent ?? sender.log ?? sender.messages;
  const x = sent[sent.length - 1];
  return x.msg ?? x.message ?? x;
};
const call = { id: "c1", callerId: "u_a", video: true, expiresAt: 123, caller: { name: "Donny Dey", photoUrl: "https://x/p.jpg" } };

test("incoming call push carries everything the native ring UI needs", async () => {
  const { n, sender } = mk();
  await n.registerToken("u_b", "tok-b-0123456789abcdef0123456789", "android");
  assert.equal(await n.callIncoming("u_b", call), "sent");
  const m = last(sender);
  assert.equal(m.type, "call_incoming");
  assert.equal(m.url, "/call/c1");
  assert.equal(m.tag, "call:c1");
  assert.deepEqual({ callId: m.data.callId, video: m.data.video, expiresAt: m.data.expiresAt, callerPhoto: m.data.callerPhoto }, { callId: "c1", video: "1", expiresAt: "123", callerPhoto: "https://x/p.jpg" });
  await n.callCancel("u_b", "c1", "cancelled");
  const c = last(sender);
  assert.equal(c.type, "call_cancel");
  assert.equal(c.clear, true);
  assert.equal(c.tag, "call:c1");
});

test("missed call push: Call back deep link; skipped in the foreground", async () => {
  const { n, sender } = mk();
  await n.registerToken("u_b", "tok-b-0123456789abcdef0123456789", "ios");
  assert.equal(await n.missedCall({ fromId: "u_a", toId: "u_b", fromName: "Donny Dey", call: { id: "c2", video: false } }), "sent");
  const m = last(sender);
  assert.equal(m.title, "Missed call");
  assert.match(m.body, /Donny Dey · audio call/);
  assert.equal(m.url, "/messages/u_a?call=audio");
  assert.equal(m.data.action, "callback");
  const fg = mk(true);
  await fg.n.registerToken("u_b", "tok-b-0123456789abcdef0123456789", "ios");
  assert.equal(await fg.n.missedCall({ fromId: "u_a", toId: "u_b", fromName: "Donny Dey" }), "skip:foreground");
});
