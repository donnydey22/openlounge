"use client";

import { CornerUpRight, File, Image, Mic, Video, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReplyReference } from "@/lib/types";
import { replySummary } from "@/lib/chat/reply";
import { cn, firstName } from "@/lib/utils";
import { cachedUrls, onCachedUrls } from "@/lib/media/client";

function ReplyMediaPreview({ reply }: { reply: ReplyReference }) {
  const id = reply.mediaId;
  const [urls, setUrls] = useState(() => (id ? cachedUrls(id) : null));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!id) {
      setUrls(null);
      return;
    }
    setUrls(cachedUrls(id));
    return onCachedUrls(id, () => setUrls(cachedUrls(id)));
  }, [id]);
  const src = reply.mediaKind === "photo" ? urls?.thumb : reply.mediaKind === "video" ? urls?.poster : undefined;
  if (src && !failed)
    return <img src={src} alt="" onError={() => setFailed(true)} className="h-9 w-9 shrink-0 rounded-md object-cover" data-testid="reply-media-thumb" />;
  const Icon = reply.mediaKind === "voice" ? Mic : reply.mediaKind === "video" ? Video : reply.mediaKind === "document" ? File : Image;
  return <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-black/10 opacity-80" data-testid="reply-media-icon"><Icon className="h-4 w-4" aria-hidden /></span>;
}

/** Tappable quote shown on a sent reply. The original stays authoritative in the thread. */
export function ReplyQuote({ reply, mine, onJump, className }: { reply: ReplyReference; mine?: boolean; onJump: (messageId: string) => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onJump(reply.messageId);
      }}
      className={cn(
        "mb-1.5 flex w-full min-w-0 items-stretch gap-2 overflow-hidden rounded-lg bg-black/10 px-2 py-1.5 text-left transition hover:bg-black/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
        mine ? "text-emerald-50" : "text-zinc-200",
        className,
      )}
      aria-label={`Jump to ${firstName(reply.senderName)}'s original message`}
      data-testid="reply-quote"
      data-reply-to={reply.messageId}
    >
      <span className={cn("w-0.5 shrink-0 rounded-full", mine ? "bg-emerald-100/80" : "bg-emerald-400")} />
      {reply.mediaKind && <ReplyMediaPreview reply={reply} />}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-[12px] font-semibold leading-tight", mine ? "text-emerald-50" : "text-emerald-400")}>{firstName(reply.senderName)}</span>
        <span className="block truncate text-[12px] leading-tight opacity-80">{replySummary(reply)}</span>
      </span>
      <CornerUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
    </button>
  );
}

/** The compact Telegram/WhatsApp-style composer state for the reply being composed. */
export function ReplyComposerPreview({ reply, onCancel, className }: { reply: ReplyReference; onCancel: () => void; className?: string }) {
  return (
    <div className={cn("mb-1.5 flex min-w-0 items-center gap-2 rounded-xl border border-white/10 bg-zinc-900/90 px-2.5 py-2 shadow-lg", className)} data-testid="reply-composer-preview">
      <span className="h-8 w-0.5 shrink-0 rounded-full bg-emerald-400" />
      {reply.mediaKind && <ReplyMediaPreview reply={reply} />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-emerald-400">Replying to {firstName(reply.senderName)}</span>
        <span className="block truncate text-xs text-zinc-400">{replySummary(reply)}</span>
      </span>
      <button type="button" onClick={onCancel} aria-label="Cancel reply" className="rounded-full p-1.5 text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100" data-testid="reply-cancel">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
