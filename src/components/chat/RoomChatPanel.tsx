"use client";

import { FormattedText } from "./FormattedText";
import { LinkifiedText } from "./LinkifiedText";
import { DELETED_NAME, isDeletedId, useDeletedIds } from "@/lib/userDisplay";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Flag, Pencil, Trash2, X } from "lucide-react";
import type { ChatMessage } from "@/lib/types";
import { cn, firstName } from "@/lib/utils";
import { formatClock, serverNow, useClockTick } from "@/lib/time";
import { Avatar } from "../Avatar";
import { ChatComposer } from "./ChatComposer";
import { StickerMessage } from "../stickers/StickerMessage";
import { parseSticker } from "@/lib/stickers/token";
import { ReplyGesture } from "./ReplyGesture";
import { ReplyComposerPreview, ReplyQuote } from "./ReplyQuote";
import { replyReference } from "@/lib/chat/reply";
import { jumpToMessage } from "../groups/GroupBits";

const GROUP_WINDOW_MS = 2 * 60_000;

export { formatClock };

/** Soft, glanceable timestamps: "now", "4m", "1h". */
export function softTime(ts: number) {
  const s = Math.max(0, Math.floor((serverNow() - ts) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : formatClock(ts);
}

/**
 * Light, Clubhouse-adjacent room chat: compact bubbles, first names, soft
 * timestamps. Deliberately secondary to the stage — no dense chrome.
 */

const roomLeaf = (t: string) => <LinkifiedText text={t} />;

export function RoomChatPanel({
  messages,
  meId,
  hostId,
  canModerate,
  canModerateHost = false,
  connected,
  onSend,
  onDelete,
  onEdit,
  onAuthorClick,
  onReport,
  hiddenIds,
  onClose,
  className,
}: {
  messages: ChatMessage[];
  meId: string | undefined;
  hostId: string;
  canModerate: boolean;
  /** Only the host may remove a host-authored room-chat message. */
  canModerateHost?: boolean;
  connected: boolean;
  onSend: (text: string, replyToId?: string) => Promise<boolean>;
  onDelete: (messageId: string) => void;
  /** save an edit of my own message; false keeps edit mode open */
  onEdit?: (messageId: string, text: string) => Promise<boolean>;
  onAuthorClick: (userId: string) => void;
  /** report someone else's message (App Store 1.2) */
  onReport?: (message: ChatMessage) => void;
  /** authors whose messages are hidden (blocked either way) */
  hiddenIds?: Set<string>;
  onClose?: () => void;
  className?: string;
}) {
  const all = messages;
  messages = hiddenIds?.size ? all.filter((m) => !hiddenIds.has(m.authorId)) : all;
  useDeletedIds(); // live "Deleted Account" for authors who delete their account
  useClockTick(); // soft stamps ("now" → "4m") keep counting
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [replying, setReplying] = useState<import("@/lib/types").ReplyReference | null>(null);
  const [, setTick] = useState(0);

  // re-render every 30s so soft timestamps stay fresh
  useEffect(() => {
    const iv = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(iv);
  }, []);

  const scrollToBottom = (smooth = false) => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };

  useLayoutEffect(() => {
    scrollToBottom();
  }, []);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (atBottom.current || last?.authorId === meId) {
      scrollToBottom(true);
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, [messages, meId]);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <h2 className="text-sm font-semibold text-zinc-300">
          Chat <span className="font-normal text-zinc-500">· {messages.length}</span>
        </h2>
        {onClose && (
          <button onClick={onClose} className="-mr-1 rounded-full p-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-100" aria-label="Close chat">
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (atBottom.current) setShowJump(false);
          }}
          className="chat-fade h-full overflow-y-auto overscroll-contain px-3 pt-2 pb-3"
        >
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-1 py-10 text-center text-sm text-zinc-500">
              <div className="text-2xl">💬</div>
              Chat quietly while you listen.
            </div>
          )}
          {messages.map((m, i) => {
            const prev = messages[i - 1];
            const grouped = !!prev && prev.authorId === m.authorId && m.createdAt - prev.createdAt < GROUP_WINDOW_MS;
            const mine = m.authorId === meId;
            const sticker = parseSticker(m.text); // sticker message: large, no bubble
            const canDelete = mine || (canModerate && (m.authorId !== hostId || canModerateHost));
            const canReport = !mine && !!onReport && !m.authorIsBot;
            const canEdit = !!onEdit && mine && !sticker && Date.now() - m.createdAt < 48 * 3600_000;
            // Reply is universal; moderation actions remain exactly as before.
            const canAct = true;
            const isHost = m.authorId === hostId;
            const roleMark = isHost ? "✳︎" : m.authorRole === "speaker" ? "🎙" : null;
            return (
              <ReplyGesture key={m.id} messageId={m.id} onReply={() => setReplying(replyReference(m))} testId="room-replyable-message">
              <div data-testid="dm-msg" data-mid={m.id} className={cn("flex items-end gap-2", mine ? "justify-end" : "justify-start", grouped ? "mt-0.5" : "mt-2.5")}>
                {!mine && (
                  <div className="w-6 shrink-0">
                    {!grouped && (
                      <button onClick={() => onAuthorClick(m.authorId)} aria-label={`Open ${m.authorName}`}>
                        <Avatar name={isDeletedId(m.authorId) ? DELETED_NAME : m.authorName} color={m.authorColor} photo={isDeletedId(m.authorId) ? null : m.authorPhotoUrl} size="xs" className="scale-[0.86]" />
                      </button>
                    )}
                  </div>
                )}
                <div
                  onClick={() => canAct && setSelected((s) => (s === m.id ? null : m.id))}
                  className={cn(
                    "group relative max-w-[82%] px-3 py-1.5",
                    sticker ? "bg-transparent !px-0" : mine ? "rounded-2xl rounded-br-md bg-emerald-500/15" : "rounded-2xl rounded-bl-md bg-zinc-800/70",
                    canAct && "cursor-pointer",
                  )}
                >
                  {!grouped && !mine && (
                    <div className="flex items-baseline gap-1.5 text-[12px] leading-tight">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onAuthorClick(m.authorId);
                        }}
                        className="font-semibold text-zinc-200 hover:underline"
                      >
                        {isDeletedId(m.authorId) ? DELETED_NAME : firstName(m.authorName)}
                      </button>
                      {roleMark && (
                        <span className={isHost ? "text-emerald-400" : "text-[10px]"} title={isHost ? "Host" : "Speaker"}>
                          {roleMark}
                        </span>
                      )}
                      <span className="text-[10px] text-zinc-500">{softTime(m.createdAt)}</span>
                    </div>
                  )}
                  {m.replyTo && <ReplyQuote reply={m.replyTo} mine={mine} onJump={(messageId) => jumpToMessage(listRef.current, messageId)} />}
                  {sticker ? <StickerMessage sticker={sticker} size={112} /> : <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[14px] leading-snug text-zinc-100"><FormattedText text={m.text} leaf={roomLeaf} /></p>}
                  {(m.editedAt || (!grouped && mine)) && (
                    <div className={cn("mt-0.5 text-[10px] leading-none text-zinc-500", mine && "text-right")} data-testid={m.editedAt ? "room-chat-edited" : undefined}>
                      {m.editedAt ? "edited" : ""}
                      {m.editedAt && !grouped && mine ? " · " : ""}
                      {!grouped && mine ? softTime(m.createdAt) : ""}
                    </div>
                  )}
                  {canAct && (
                    <div
                      className={cn(
                        "absolute top-1/2 flex -translate-y-1/2 gap-1 transition",
                        mine ? "right-full mr-1.5" : "left-full ml-1.5",
                        selected === m.id ? "opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
                      )}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected(null);
                          setEditing(null);
                          setReplying(replyReference(m));
                        }}
                        title="Reply"
                        aria-label="Reply"
                        data-testid="room-chat-reply"
                        className="rounded-full bg-zinc-800 p-1.5 text-zinc-400 shadow hover:text-emerald-400"
                      >
                        ↩
                      </button>
                      {canReport && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(null);
                            onReport!(m);
                          }}
                          title="Report message"
                          aria-label="Report message"
                          className="rounded-full bg-zinc-800 p-1.5 text-zinc-400 shadow hover:text-amber-400"
                        >
                          <Flag className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {canEdit && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(null);
                            setEditing({ id: m.id, text: m.text });
                          }}
                          title="Edit message"
                          aria-label="Edit message"
                          data-testid="room-chat-edit"
                          className="rounded-full bg-zinc-800 p-1.5 text-zinc-400 shadow hover:text-emerald-400"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {canDelete && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(m.id);
                          }}
                          title={mine ? "Delete message" : "Remove message (host)"}
                          aria-label="Delete message"
                          className="rounded-full bg-zinc-800 p-1.5 text-zinc-400 shadow hover:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
              </ReplyGesture>
            );
          })}
        </div>
        {showJump && (
          <button
            onClick={() => scrollToBottom(true)}
            className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-200 shadow-lg ring-1 ring-white/10"
          >
            <ArrowDown className="h-3.5 w-3.5" /> New
          </button>
        )}
      </div>

      <div className="px-3 pt-1 pb-3">
        <ChatComposer
          onSend={async (text) => {
            const ok = await onSend(text, replying?.messageId);
            if (ok) setReplying(null);
            return ok;
          }}
          disabled={!connected}
          placeholder="Say something nice…"
          compact
          editing={editing}
          onEditSave={async (text) => (editing && onEdit ? onEdit(editing.id, text) : false)}
          onEditCancel={() => setEditing(null)}
          above={replying ? () => <ReplyComposerPreview reply={replying} onCancel={() => setReplying(null)} /> : undefined}
        />
      </div>
    </div>
  );
}
