"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Loader2, X } from "lucide-react";
import type { DirectMessage, PublicUser } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useApp } from "../AppProvider";
import { Avatar } from "../Avatar";
import { ChatComposer } from "./ChatComposer";
import { formatClock } from "./RoomChatPanel";
import { FollowButton } from "../UserRow";

const GROUP_WINDOW_MS = 5 * 60_000;

function dayLabel(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/**
 * A 1:1 conversation. Used full-screen on /messages/[peerId] and as a drawer
 * inside rooms (so you can DM someone without leaving the room).
 */
export function DmThread({
  peerId,
  onBack,
  backStyle = "chevron",
  className,
}: {
  peerId: string;
  onBack: () => void;
  backStyle?: "chevron" | "close";
  className?: string;
}) {
  const { socket, connected, me, request, toast, setActiveDm } = useApp();
  const [peer, setPeer] = useState<PublicUser | null>(null);
  const [messages, setMessages] = useState<DirectMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peerTyping, setPeerTyping] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSent = useRef(0);
  const isSelf = me?.id === peerId;

  const markRead = useCallback(() => {
    socket?.emit("dm:read", { peerId });
  }, [socket, peerId]);

  // load history (re-runs on reconnect so nothing is missed)
  useEffect(() => {
    if (!connected || isSelf) return;
    request<{ peer: PublicUser; messages: DirectMessage[]; hasMore: boolean }>("dm:history", { peerId })
      .then((r) => {
        setPeer(r.peer);
        setMessages(r.messages);
        setHasMore(r.hasMore);
        stickToBottom.current = true;
        markRead();
      })
      .catch((e: Error) => setError(e.message));
  }, [connected, peerId, request, markRead, isSelf]);

  useEffect(() => {
    setActiveDm(peerId);
    return () => setActiveDm(null);
  }, [peerId, setActiveDm]);

  // live delivery + typing indicator
  useEffect(() => {
    if (!socket) return;
    const onMsg = (m: DirectMessage) => {
      const inThread = (m.fromId === peerId && m.toId === me?.id) || (m.fromId === me?.id && m.toId === peerId);
      if (!inThread) return;
      setMessages((list) => (list && !list.some((x) => x.id === m.id) ? [...list, m] : list));
      if (m.fromId === peerId) {
        setPeerTyping(false);
        if (document.visibilityState === "visible") markRead();
      }
    };
    const onTyping = ({ from }: { from: string }) => {
      if (from !== peerId) return;
      setPeerTyping(true);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => setPeerTyping(false), 3500);
    };
    const onVisible = () => document.visibilityState === "visible" && markRead();
    socket.on("dm:message", onMsg);
    socket.on("dm:typing", onTyping);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      socket.off("dm:message", onMsg);
      socket.off("dm:typing", onTyping);
      document.removeEventListener("visibilitychange", onVisible);
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, [socket, peerId, me?.id, markRead]);

  // keep pinned to the latest message unless the user scrolled up
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, peerTyping]);

  const loadEarlier = async () => {
    if (!messages?.length || loadingMore) return;
    setLoadingMore(true);
    const el = listRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    try {
      const r = await request<{ messages: DirectMessage[]; hasMore: boolean }>("dm:history", { peerId, before: messages[0].createdAt });
      stickToBottom.current = false;
      setMessages((list) => [...r.messages, ...(list ?? [])]);
      setHasMore(r.hasMore);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight;
      });
    } finally {
      setLoadingMore(false);
    }
  };

  const send = async (text: string) => {
    try {
      const r = await request<{ message: DirectMessage }>("dm:send", { to: peerId, text });
      stickToBottom.current = true;
      setMessages((list) => (list && !list.some((x) => x.id === r.message.id) ? [...list, r.message] : list));
      return true;
    } catch (e) {
      toast((e as Error).message);
      return false;
    }
  };

  const onTyping = () => {
    const now = Date.now();
    if (now - lastTypingSent.current > 2500) {
      lastTypingSent.current = now;
      socket?.emit("dm:typing", { to: peerId });
    }
  };

  if (isSelf || error) {
    return (
      <div className={cn("flex flex-col items-center justify-center gap-3 px-6 text-center text-zinc-400", className)}>
        <div className="text-4xl">{isSelf ? "🪞" : "🔍"}</div>
        {isSelf ? "You can't message yourself." : error}
        <button onClick={onBack} className="text-emerald-400 hover:underline">
          Go back
        </button>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col", className)}>
      <header className="flex h-16 shrink-0 items-center gap-2 border-b border-white/5 px-2">
        <button onClick={onBack} className="rounded-full p-2 text-zinc-300 hover:bg-white/5" aria-label={backStyle === "close" ? "Close" : "Back to messages"}>
          {backStyle === "close" ? <X className="h-5 w-5" /> : <ChevronLeft className="h-6 w-6" />}
        </button>
        {peer ? (
          <Link href={`/profile/${peer.id}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 hover:bg-white/5">
            <Avatar name={peer.name} color={peer.color} photo={peer.photoUrl} size="sm" />
            <div className="min-w-0">
              <div className="truncate font-semibold">{peer.name}</div>
              <div className="truncate text-xs text-zinc-500">
                {peerTyping ? <span className="text-emerald-400">typing…</span> : peer.isBot ? "Demo user · replies automatically" : "Direct message"}
              </div>
            </div>
          </Link>
        ) : (
          <div className="flex-1" />
        )}
        {peer && (
          <div className="pr-2">
            <FollowButton userId={peer.id} small />
          </div>
        )}
      </header>

      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4"
      >
        {messages === null ? (
          <div className="flex justify-center py-16 text-zinc-500">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <>
            {hasMore && (
              <div className="mb-3 flex justify-center">
                <button onClick={loadEarlier} className="rounded-full border border-white/10 px-4 py-1.5 text-xs text-zinc-400 hover:bg-white/5">
                  {loadingMore ? "Loading…" : "Load earlier messages"}
                </button>
              </div>
            )}
            {messages.length === 0 && peer && (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <Avatar name={peer.name} color={peer.color} photo={peer.photoUrl} size="lg" />
                <div className="font-semibold">{peer.name}</div>
                <p className="max-w-xs text-sm text-zinc-500">{peer.bio || "Say hi 👋 — messages are delivered instantly."}</p>
              </div>
            )}
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const next = messages[i + 1];
              const mine = m.fromId === me?.id;
              const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
              const groupedWithNext = !!next && next.fromId === m.fromId && next.createdAt - m.createdAt < GROUP_WINDOW_MS;
              const groupedWithPrev = !newDay && !!prev && prev.fromId === m.fromId && m.createdAt - prev.createdAt < GROUP_WINDOW_MS;
              return (
                <div key={m.id}>
                  {newDay && (
                    <div className="my-4 text-center text-[11px] font-medium uppercase tracking-wide text-zinc-600">{dayLabel(m.createdAt)}</div>
                  )}
                  <div className={cn("flex", mine ? "justify-end" : "justify-start", groupedWithPrev ? "mt-0.5" : "mt-3")}>
                    <div
                      className={cn(
                        "max-w-[78%] px-3.5 py-2 text-[15px] leading-snug whitespace-pre-wrap break-words",
                        mine ? "rounded-2xl rounded-br-md bg-emerald-500 text-on-accent" : "rounded-2xl rounded-bl-md bg-zinc-800 text-zinc-100",
                      )}
                    >
                      {m.text}
                    </div>
                  </div>
                  {!groupedWithNext && (
                    <div className={cn("mt-1 px-1 text-[10px] text-zinc-600", mine ? "text-right" : "text-left")}>{formatClock(m.createdAt)}</div>
                  )}
                </div>
              );
            })}
            {peerTyping && (
              <div className="mt-3 flex justify-start">
                <div className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-zinc-800 px-4 py-3" aria-label="typing">
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-zinc-400" />
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-zinc-400 [animation-delay:150ms]" />
                  <span className="typing-dot h-1.5 w-1.5 rounded-full bg-zinc-400 [animation-delay:300ms]" />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-white/5 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <ChatComposer onSend={send} onTyping={onTyping} disabled={!connected || messages === null} placeholder={peer ? `Message ${peer.name.split(" ")[0]}…` : "Message…"} autoFocus />
      </div>
    </div>
  );
}
