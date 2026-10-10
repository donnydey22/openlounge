"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Flag, Pencil, Reply, Trash2, X } from "lucide-react";
import type { ChatMessage } from "@/lib/types";
import { cn, firstName } from "@/lib/utils";
import { formatClock, serverNow, useClockTick } from "@/lib/time";
import { Avatar } from "../Avatar";
import { ChatComposer } from "./ChatComposer";
import { MessageText } from "./MessageText";
import { ReplyPreview } from "./ReplyPreview";
import type { ComposerAction } from "./ChatComposer";

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
export function RoomChatPanel({
  messages,
  meId,
  hostId,
  canModerate,
  connected,
  onSend,
  onDelete,
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
  connected: boolean;
  onSend: (text: string, context?: { replyToId?: string; editMessageId?: string }) => Promise<boolean>;
  onDelete: (messageId: string) => void;
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
  useClockTick(); // soft stamps ("now" → "4m") keep counting
  const listRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [composerAction, setComposerAction] = useState<ComposerAction | null>(null);
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
            const canDelete = mine || canModerate;
            const canReport = !mine && !!onReport && !m.authorIsBot;
            const canEdit = mine;
            const canReply = true;
            const canAct = canDelete || canReport || canEdit || canReply;
            const isHost = m.authorId === hostId;
            const roleMark = isHost ? "✳︎" : m.authorRole === "speaker" ? "🎙" : null;
            return (
              <div key={m.id} className={cn("flex items-end gap-2", mine ? "justify-end" : "justify-start", grouped ? "mt-0.5" : "mt-2.5")}>
                {!mine && (
                  <div className="w-6 shrink-0">
                    {!grouped && (
                      <button onClick={() => onAuthorClick(m.authorId)} aria-label={`Open ${m.authorName}`}>
                        <Avatar name={m.authorName} color={m.authorColor} photo={m.authorPhotoUrl} size="xs" className="scale-[0.86]" />
                      </button>
                    )}
                  </div>
                )}
                <div
                  onClick={() => canAct && setSelected((s) => (s === m.id ? null : m.id))}
                  className={cn(
                    "group relative max-w-[82%] px-3 py-1.5",
                    mine ? "rounded-2xl rounded-br-md bg-emerald-500/15" : "rounded-2xl rounded-bl-md bg-zinc-800/70",
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
                        {firstName(m.authorName)}
                      </button>
                      {roleMark && (
                        <span className={isHost ? "text-emerald-400" : "text-[10px]"} title={isHost ? "Host" : "Speaker"}>
                          {roleMark}
                        </span>
                      )}
                      <span className="text-[10px] text-zinc-500">{softTime(m.createdAt)}</span>
                    </div>
                  )}
                  <div className="whitespace-pre-wrap break-words text-[14px] leading-snug text-zinc-100">
                    {m.replyTo && <ReplyPreview reply={m.replyTo} />}
                    <MessageText text={m.text} />
                    {m.editedAt && <span className="ml-1.5 text-[10px] font-medium text-zinc-500">Edited</span>}
                  </div>
                  {!grouped && mine && <div className="mt-0.5 text-right text-[10px] leading-none text-zinc-500">{softTime(m.createdAt)}</div>}
                  {canAct && (
                    <div
                      className={cn(
                        "absolute top-1/2 flex -translate-y-1/2 gap-1 transition",
                        mine ? "right-full mr-1.5" : "left-full ml-1.5",
                        selected === m.id ? "opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
                      )}
                    >
                      {canReply && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(null);
                            setComposerAction({ kind: "reply", messageId: m.id, authorName: m.authorName, text: m.text });
                          }}
                          title="Reply"
                          aria-label="Reply to message"
                          className="rounded-full bg-zinc-800 p-1.5 text-zinc-400 shadow hover:text-emerald-400"
                        >
                          <Reply className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {canEdit && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(null);
                            setComposerAction({ kind: "edit", messageId: m.id, text: m.text });
                          }}
                          title="Edit message"
                          aria-label="Edit message"
                          className="rounded-full bg-zinc-800 p-1.5 text-zinc-400 shadow hover:text-zinc-100"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
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
        <ChatComposer onSend={onSend} disabled={!connected} placeholder="Say something nice…" compact action={composerAction} onCancelAction={() => setComposerAction(null)} />
      </div>
    </div>
  );
}
