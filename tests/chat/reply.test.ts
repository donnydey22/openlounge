import assert from "node:assert/strict";
import { test } from "node:test";
import { replyReference, replySummary } from "../../src/lib/chat/reply";
import { stickerText } from "../../src/lib/stickers/token";
import type { ChatMessage, DirectMessage } from "../../src/lib/types";

const base = (overrides: Partial<DirectMessage> = {}): DirectMessage => ({
  id: "message-1",
  fromId: "alice",
  fromName: "Alice Example",
  fromColor: "#0f0",
  toId: "bob",
  text: "hello",
  createdAt: 1,
  ...overrides,
});

test("reply references use only server message fields for text, media, stickers, calls, links, and forwarded text", () => {
  const cases: Array<{ message: DirectMessage; summary: string }> = [
    { message: base({ text: "Plain text" }), summary: "Plain text" },
    { message: base({ text: "https://openlounge.app/room/abc" }), summary: "https://openlounge.app/room/abc" },
    { message: base({ text: "Forwarded from Maya: hello" }), summary: "Forwarded from Maya: hello" },
    { message: base({ text: "📷 Sunset", media: { id: "p", kind: "photo", mime: "image/jpeg", name: "sunset.jpg", size: 1, status: "ready" } }), summary: "📷 Sunset" },
    { message: base({ text: "Video", media: { id: "v", kind: "video", mime: "video/mp4", name: "note.mp4", size: 1, status: "ready" } }), summary: "Video" },
    { message: base({ text: "Voice message", media: { id: "a", kind: "voice", mime: "audio/ogg", name: "voice.ogg", size: 1, status: "ready" } }), summary: "Voice message" },
    { message: base({ text: "File", media: { id: "d", kind: "document", mime: "application/pdf", name: "brief.pdf", size: 1, status: "ready" } }), summary: "File" },
    { message: base({ text: stickerText({ packId: "starter", stickerId: "wave", emoji: "👋" }) }), summary: "Sticker" },
    { message: base({ kind: "call", text: "☎ Video call · 1:03" }), summary: "☎ Video call · 1:03" },
  ];
  for (const { message, summary } of cases) {
    const reference = replyReference(message);
    assert.equal(reference.messageId, "message-1");
    assert.equal(reference.senderId, "alice");
    assert.equal(reference.senderName, "Alice Example");
    assert.equal(replySummary(reference), summary);
    assert.equal("url" in reference, false, "a quote never embeds a signed media URL");
  }
});

test("room reply references snapshot the room author without client-provided identity", () => {
  const room: ChatMessage = {
    id: "room-message",
    roomId: "room-1",
    authorId: "host",
    authorName: "Host Person",
    authorColor: "#0f0",
    authorPhotoUrl: null,
    authorRole: "host",
    authorIsBot: false,
    text: "Welcome to the room",
    createdAt: 1,
  };
  assert.deepEqual(replyReference(room), {
    messageId: "room-message",
    senderId: "host",
    senderName: "Host Person",
    text: "Welcome to the room",
  });
});
