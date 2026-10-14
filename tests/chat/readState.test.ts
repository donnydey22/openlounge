import assert from "node:assert/strict";
import test from "node:test";
import { applyOwnDirectReadState } from "../../src/lib/chat/readState";
import type { ConversationSummary } from "../../src/lib/types";

const row = (peerId: string, unread: number): ConversationSummary => ({
  peer: { id: peerId, name: peerId, username: peerId, bio: "", color: "#000", photoUrl: null, interests: [], isBot: false, createdAt: 1, followers: 0, following: 0 },
  lastMessage: { id: `m_${peerId}`, fromId: peerId, toId: "u_me", fromName: peerId, fromColor: "#000", text: "hello", createdAt: 1, readAt: null },
  unread,
});

test("direct read state updates only its matching inbox row", () => {
  const rows = [row("u_maya", 2), row("u_ian", 4)];
  const next = applyOwnDirectReadState(rows, "u_me", { peerId: "u_maya", unread: 0, total: 4 });
  assert.equal(next?.[0].unread, 0);
  assert.equal(next?.[1].unread, 4);
  assert.notEqual(next, rows);
});

test("direct read state preserves a newer message that arrived after the seen cursor", () => {
  const rows = [row("u_maya", 2)];
  const next = applyOwnDirectReadState(rows, "u_me", { peerId: "u_maya", unread: 1, total: 1 });
  assert.equal(next?.[0].unread, 1);
});

test("group state and unchanged state cannot alter direct-message rows", () => {
  const rows = [row("u_maya", 2)];
  assert.equal(applyOwnDirectReadState(rows, "u_me", { peerId: "g_group", unread: 0, total: 0 }), rows);
  assert.equal(applyOwnDirectReadState(rows, "u_me", { peerId: "u_maya", unread: 2, total: 2 }), rows);
});
