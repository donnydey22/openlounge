import type { ChatMessage, DirectMessage, ReplyReference } from "@/lib/types";
import { parseSticker } from "@/lib/stickers/token";
import { formatDuration, itemsOf } from "@/lib/media/types";

/** A short server-generated snapshot of the message a reply points at. */
export function replyReference(message: DirectMessage | ChatMessage): ReplyReference {
  const direct = "fromId" in message;
  const senderId = direct ? message.fromId : message.authorId;
  const senderName = direct ? message.fromName : message.authorName;
  const items = direct ? itemsOf(message) : [];
  const media = items[0];
  const kind = direct ? message.kind : undefined;
  const text = message.text.trim();
  return {
    messageId: message.id,
    senderId,
    senderName,
    text: text.slice(0, 500),
    ...(media ? { mediaId: media.id, mediaKind: media.kind, ...(media.name ? { mediaName: media.name } : {}), ...(typeof media.durMs === "number" ? { mediaDurationMs: media.durMs } : {}) } : {}),
    ...(items.length > 1 ? { albumCount: items.length, albumPhotoCount: items.filter((item) => item.kind === "photo").length } : {}),
    ...(kind ? { messageKind: kind } : {}),
    ...(parseSticker(text) ? { sticker: true } : {}),
  };
}

/** Human-readable, media-safe quote preview. Never needs a signed media URL. */
export function replySummary(reply: ReplyReference): string {
  if (reply.sticker) return "Sticker";
  if (reply.albumCount && reply.albumCount > 1) {
    const photos = reply.albumPhotoCount ?? 0;
    return photos === reply.albumCount ? `Album, ${photos} photos` : `Album, ${reply.albumCount} items`;
  }
  if (reply.mediaKind === "photo") return "Photo";
  if (reply.mediaKind === "video") return reply.mediaDurationMs ? `Video · ${formatDuration(reply.mediaDurationMs)}` : "Video";
  if (reply.mediaKind === "voice") return reply.mediaDurationMs ? `Voice message · ${formatDuration(reply.mediaDurationMs)}` : "Voice message";
  if (reply.mediaKind === "document") return reply.mediaName || "File";
  if (reply.messageKind === "call") return reply.text || "Call";
  if (reply.messageKind === "room_invite" || reply.messageKind === "dropin") return reply.text || "Room invite";
  return reply.text || "Message";
}
