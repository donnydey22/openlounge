import assert from "node:assert/strict";
import test from "node:test";
import { parseNativePushNotice } from "../../src/lib/nativeNotification";

test("accepts a bounded foreground DM notification with its unread badge", () => {
  assert.deepEqual(
    parseNativePushNotice({
      type: "dm",
      title: "Maya",
      body: "Are you around?",
      tag: "dm:u_maya",
      url: "/messages/u_maya",
      channel: "messages",
      badge: "3",
      sentAt: "1790000000123",
      peerId: "u_maya",
    }),
    {
      type: "dm",
      title: "Maya",
      body: "Are you around?",
      tag: "dm:u_maya",
      url: "/messages/u_maya",
      channel: "messages",
      clear: false,
      badge: 3,
      sentAt: 1790000000123,
      peerId: "u_maya",
      groupId: undefined,
      roomId: undefined,
    },
  );
});

test("accepts a tag-only clear payload and preserves a zero badge", () => {
  const n = parseNativePushNotice({ type: "clear", title: "", body: "", tag: "dm:u_maya", url: "", clear: "1", badge: "0" });
  assert.ok(n);
  assert.equal(n.clear, true);
  assert.equal(n.badge, 0);
  assert.equal(n.url, "");
});

test("rejects unsafe routes and incomplete display payloads", () => {
  assert.equal(parseNativePushNotice({ type: "dm", title: "Maya", tag: "dm:u_maya", url: "https://example.test" }), null);
  assert.equal(parseNativePushNotice({ type: "dm", title: "", tag: "dm:u_maya", url: "/messages/u_maya" }), null);
  assert.equal(parseNativePushNotice({ type: "dm", title: "Maya", tag: "", url: "/messages/u_maya" }), null);
});

test("bounds text and ignores malformed optional identifiers", () => {
  const n = parseNativePushNotice({
    type: "followedRoom",
    title: "x".repeat(300),
    body: "y".repeat(800),
    tag: "room:r_1",
    url: "/room/r_1",
    badge: 12_345,
    roomId: "bad room id",
  });
  assert.ok(n);
  assert.equal(n.title.length, 140);
  assert.equal(n.body.length, 500);
  assert.equal(n.badge, 9999);
  assert.equal(n.roomId, undefined);
});
