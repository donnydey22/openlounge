// Sticker messages ride inside the existing text message (DMs and room chat) so no server data model or WebSocket
// protocol change is needed, and older cached clients / push notifications still show something sensible:
//
//   "😀 Sticker" + <invisible Unicode TAG characters spelling "stk:<packId>/<stickerId>"> + CANCEL TAG
//
// TAG characters (U+E0020–U+E007E) are default-ignorable: every renderer hides them, so an old client or a push
// notification shows "😀 Sticker". New clients detect the payload and draw a large, bubble-less sticker.

const TAG_BASE = 0xe0000;
const CANCEL = String.fromCodePoint(0xe007f);
const PREFIX = "stk:";
export const STICKER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface StickerRef {
  packId: string;
  stickerId: string;
  /** the emoji shown to clients that can't draw stickers */
  emoji: string;
}

const toTags = (s: string) => [...s].map((c) => String.fromCodePoint(TAG_BASE + c.charCodeAt(0))).join("");
const PAYLOAD_RE = /([\u{E0020}-\u{E007E}]+)\u{E007F}/u;

export function stickerText(ref: StickerRef): string {
  if (!STICKER_ID_RE.test(ref.packId) || !STICKER_ID_RE.test(ref.stickerId)) throw new Error("bad sticker id");
  const emoji = [...(ref.emoji || "🙂")].slice(0, 8).join("");
  return `${emoji} Sticker${toTags(PREFIX + ref.packId + "/" + ref.stickerId)}${CANCEL}`;
}

/** The sticker in a message, or null for ordinary text. Cheap: a single indexOf for normal messages. */
export function parseSticker(text: string | null | undefined): StickerRef | null {
  if (!text || text.indexOf(CANCEL) === -1) return null;
  const m = PAYLOAD_RE.exec(text);
  if (!m) return null;
  const decoded = [...m[1]].map((c) => String.fromCharCode(c.codePointAt(0)! - TAG_BASE)).join("");
  if (!decoded.startsWith(PREFIX)) return null;
  const [packId, stickerId, extra] = decoded.slice(PREFIX.length).split("/");
  if (extra !== undefined || !packId || !stickerId || !STICKER_ID_RE.test(packId) || !STICKER_ID_RE.test(stickerId)) return null;
  const emoji = text.slice(0, m.index).replace(/\s*Sticker\s*$/, "").trim();
  return { packId, stickerId, emoji };
}

/** Human-readable preview for inbox rows, notifications and copy: "😀 Sticker". */
export const stickerPreview = (text: string) => {
  const s = parseSticker(text);
  return s ? `${s.emoji || "🙂"} Sticker` : text;
};
