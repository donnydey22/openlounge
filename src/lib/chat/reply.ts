import type { ChatMessage, DirectMessage, ReplyReference } from "@/lib/types";
import { parseSticker } from "@/lib/stickers/token";

/** A short server-generated snapshot of the message a reply points at. */
export function replyReference(message: DirectMessage | ChatMessage): ReplyReference {
  const direct = "fromId" in message;
  const senderId = direct ? message.fromId : message.authorId;
  const senderName = direct ? message.fromName : message.authorName;
  const media = direct ? message.media : undefined;
  const kind = direct ? message.kind : undefined;
  const text = message.text.trim();
  return {
    messageId: message.id,
    senderId,
    senderName,
    text: text.slice(0, 500),
    ...(media ? { mediaKind: media.kind, mediaName: media.name } : {}),
    ...(kind ? { messageKind: kind } : {}),
    ...(parseSticker(text) ? { sticker: true } : {}),
  };
}

/** Human-readable, media-safe quote preview. Never needs a signed media URL. */
export function replySummary(reply: ReplyReference): string {
  if (reply.sticker) return "Sticker";
  if (reply.mediaKind === "photo") return reply.text || "Photo";
  if (reply.mediaKind === "video") return reply.text || "Video";
  if (reply.mediaKind === "voice") return reply.text || "Voice message";
  if (reply.mediaKind === "document") return reply.text || reply.mediaName || "File";
  if (reply.messageKind === "call") return reply.text || "Call";
  if (reply.messageKind === "room_invite" || reply.messageKind === "dropin") return reply.text || "Room invite";
  return reply.text || "Message";
}
