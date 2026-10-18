// Telegram-style forwarding: one sent message → up to 10 chats (1:1 inboxes and/or groups) in one request.
// Every target goes through the normal send paths (store.sendDm / media.send), so blocks, group membership,
// rate limits, paid-sticker rules, pushes and realtime fan-out behave exactly like a fresh send.
import { store } from "./store";
import { conversationId, isGroupId } from "./conversation";
import { media } from "./media/service";
import { MediaError } from "./media/process";
import { stickers } from "./stickers/service";

export const FORWARD_MAX_TARGETS = 10;
const ID = /^[\w:.@-]{1,128}$/;

export interface ForwardResult {
  to: string;
  ok: boolean;
  messageId?: string;
  error?: string;
}

export async function forwardMessage(userId: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; results: ForwardResult[] }> {
  const chatId = String(body.chatId ?? "");
  const messageId = String(body.messageId ?? "");
  const targets = [...new Set((Array.isArray(body.to) ? body.to : []).map((x) => String(x ?? "")))].filter((t) => ID.test(t));
  if (!ID.test(chatId) || !ID.test(messageId)) return { ok: false, error: "Message not found", results: [] };
  if (!targets.length) return { ok: false, error: "Pick at least one chat", results: [] };
  if (targets.length > FORWARD_MAX_TARGETS) return { ok: false, error: `You can forward to up to ${FORWARD_MAX_TARGETS} chats at once`, results: [] };
  const conv = conversationId(userId, chatId);
  if (isGroupId(conv) && !media.members(conv).includes(userId)) return { ok: false, error: "Message not found", results: [] };
  const msg = store.findDm(conv, messageId);
  if (!msg || (msg as { deleted?: boolean }).deleted) return { ok: false, error: "Message not found", results: [] };
  if (msg.kind || msg.call) return { ok: false, error: "This message can't be forwarded", results: [] };
  const mediaIds = msg.media || msg.attachments?.length ? media.mediaIdsOf(msg.id) : [];
  if ((msg.media || msg.attachments?.length) && !mediaIds.length) return { ok: false, error: "That attachment isn't available any more", results: [] };
  // the stored text is the caption only when the sender typed one (otherwise a label like "📷 Photo")
  const caption = mediaIds.length && media.row(mediaIds[0])?.label === false ? msg.text : "";

  const results: ForwardResult[] = [];
  for (const to of targets) {
    try {
      if (mediaIds.length) {
        const copies: string[] = [];
        for (const id of mediaIds) copies.push(await media.cloneForForward(userId, id));
        const r = media.send(userId, { to, mediaIds: copies, caption });
        results.push(r.ok ? { to, ok: true, messageId: r.message.id } : { to, ok: false, error: (r as { error?: string }).error ?? "Couldn't forward" });
      } else {
        const stickerErr = stickers().sendError(userId, msg.text);
        if (stickerErr) {
          results.push({ to, ok: false, error: stickerErr });
          continue;
        }
        const r = store.sendDm(userId, to, msg.text);
        results.push(r.ok ? { to, ok: true, messageId: r.message.id } : { to, ok: false, error: r.error ?? "Couldn't forward" });
      }
    } catch (e) {
      results.push({ to, ok: false, error: e instanceof MediaError ? e.message : "Couldn't forward" });
    }
  }
  return { ok: results.some((r) => r.ok), results };
}
