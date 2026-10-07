"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, ChevronLeft, Loader2, RotateCcw, X } from "lucide-react";
import type { DirectMessage, PublicUser } from "@/lib/types";
import { cn, firstName } from "@/lib/utils";
import { useApp } from "../AppProvider";
import { Avatar } from "../Avatar";
import { ChatComposer } from "./ChatComposer";
import { formatClock } from "./RoomChatPanel";
import { FollowButton } from "../UserRow";
import { usePresence } from "@/hooks/usePresence";

/** Consecutive messages from the same person within this window form one group (one avatar, tight spacing). */
const GROUP_WINDOW_MS = 3 * 60_000;
/** A quiet gap this long gets a centred time label (Clubhouse / iMessage style) instead of per-message stamps. */
const TIME_GAP_MS = 15 * 60_000;
const NEAR_BOTTOM_PX = 80;

/** A message on screen: confirmed by the server, or an optimistic one still in flight / failed. */
type Item = DirectMessage & { state?: "sending" | "failed" };

/** Stable React key: the client id survives the optimistic → confirmed swap, so the bubble never re-mounts. */
const keyOf = (m: Item) => m.clientId ?? m.id;

function timeLabel(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  const clock = formatClock(ts);
  if (d.toDateString() === now.toDateString()) return clock;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${clock}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })} · ${clock}`;
}

/** 1–3 emoji and nothing else → shown big, without a bubble. */
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|\p{Emoji_Modifier})*\s*){1,3}$/u;

function newClientId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Merge server messages into the list: dedupe by id / clientId, keep optimistic ones, keep order. */
function mergeMessages(list: Item[], incoming: DirectMessage[]): Item[] {
  let next = list;
  for (const m of incoming) {
    const i = next.findIndex((x) => x.id === m.id || (!!m.clientId && x.clientId === m.clientId));
    if (i >= 0) {
      if (next[i].state || next[i].id !== m.id) {
        next = next === list ? [...list] : next;
        next[i] = { ...m, clientId: next[i].clientId ?? m.clientId }; // swap in place (same key → no flicker)
      }
      continue;
    }
    next = next === list ? [...list] : next;
    // confirmed messages go before any still-pending ones of mine, in time order
    let at = next.length;
    while (at > 0 && (next[at - 1].state || next[at - 1].createdAt > m.createdAt)) at--;
    next.splice(at, 0, m);
  }
  return next;
}

/**
 * A 1:1 conversation. Used full-screen on /messages/[peerId] and as a drawer
 * inside rooms (so you can DM someone without leaving the room).
 *
 * Realtime: new messages arrive as pushed "dm:message" events (also replayed by AppProvider's
 * reconnect catch-up) — there is no polling. History is fetched once when the thread opens.
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
  const { socket, connected, offline, me, request, setActiveDm } = useApp();
  const [peer, setPeer] = useState<PublicUser | null>(null);
  const [messages, setMessages] = useState<Item[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peerTyping, setPeerTyping] = useState(false);
  const [unseenBelow, setUnseenBelow] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const smoothNext = useRef(false);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSent = useRef(0);
  const loadedFor = useRef<string | null>(null);
  const messagesRef = useRef<Item[] | null>(null);
  messagesRef.current = messages;
  const isSelf = me?.id === peerId;
  const presence = usePresence(peerId, peer?.lastSeenAt);

  const markRead = useCallback(() => {
    socket?.emit("dm:read", { peerId });
  }, [socket, peerId]);

  // reset when switching threads (drawer reuse)
  useEffect(() => {
    loadedFor.current = null;
    setPeer(null);
    setMessages(null);
    setError(null);
    setUnseenBelow(0);
    stickToBottom.current = true;
  }, [peerId]);

  // history: one fetch when the thread opens (live updates + reconnect catch-up arrive as events)
  useEffect(() => {
    if (!connected || isSelf || loadedFor.current === peerId) return;
    loadedFor.current = peerId;
    request<{ peer: PublicUser; messages: DirectMessage[]; hasMore: boolean }>("dm:history", { peerId })
      .then((r) => {
        setPeer(r.peer);
        // keep anything that arrived live / was sent while the fetch was in flight
        setMessages((list) => mergeMessages(r.messages, list ?? []));
        setHasMore(r.hasMore);
        stickToBottom.current = true;
        markRead();
      })
      .catch((e: Error) => {
        loadedFor.current = null; // retry on the next (re)connect
        if (e.message !== "Connection lost" && e.message !== "Not connected") setError(e.message);
      });
  }, [connected, peerId, request, markRead, isSelf]);

  useEffect(() => {
    setActiveDm(peerId);
    return () => setActiveDm(null);
  }, [peerId, setActiveDm]);

  // live delivery + typing indicator (pushed over the WebSocket)
  useEffect(() => {
    if (!socket) return;
    const onMsg = (m: DirectMessage) => {
      const inThread = (m.fromId === peerId && m.toId === me?.id) || (m.fromId === me?.id && m.toId === peerId);
      if (!inThread) return;
      const el = listRef.current;
      const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
      if (m.fromId === me?.id || nearBottom) {
        stickToBottom.current = true;
        smoothNext.current = true;
      } else if (!(messagesRef.current ?? []).some((x) => x.id === m.id)) {
        setUnseenBelow((n) => n + 1);
      }
      setMessages((list) => mergeMessages(list ?? [], [m]));
      if (m.fromId === peerId) {
        setPeerTyping(false);
        if (document.visibilityState === "visible") markRead();
      }
    };
    const onTyping = ({ from }: { from: string }) => {
      if (from !== peerId) return;
      const el = listRef.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) stickToBottom.current = true;
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

  // Pin to the newest message before paint (no visible jump) unless the user scrolled up.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || !stickToBottom.current) return;
    if (smoothNext.current && "scrollTo" in el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
    smoothNext.current = false;
  }, [messages, peerTyping]);

  // Keep the newest message in view when the list viewport shrinks (mobile keyboard, composer grows).
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [messages === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const scrollToBottom = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottom.current = true;
    setUnseenBelow(0);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const loadEarlier = async () => {
    if (!messages?.length || loadingMore) return;
    setLoadingMore(true);
    const el = listRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    try {
      const oldest = messages.find((m) => !m.state)?.createdAt ?? messages[0].createdAt;
      const r = await request<{ messages: DirectMessage[]; hasMore: boolean }>("dm:history", { peerId, before: oldest });
      stickToBottom.current = false;
      setMessages((list) => mergeMessages(list ?? [], r.messages));
      setHasMore(r.hasMore);
      requestAnimationFrame(() => {
        if (el) el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
      });
    } catch {
      /* stays loadable */
    } finally {
      setLoadingMore(false);
    }
  };

  // ---- optimistic send: bubble appears instantly, swaps in place when the server confirms ----
  const deliver = useCallback(
    async (item: Item) => {
      try {
        const r = await request<{ message: DirectMessage }>("dm:send", { to: peerId, text: item.text, clientId: item.clientId });
        setMessages((list) => mergeMessages(list ?? [], [{ ...r.message, clientId: item.clientId }]));
      } catch (e) {
        const msg = (e as Error).message;
        // dropped connection: stays "sending" and is re-sent on reconnect; real errors → failed (tap to retry)
        const transient = msg === "Not connected" || msg === "Connection lost" || msg === "Request timed out";
        setMessages((list) => (list ?? []).map((x) => (x.clientId === item.clientId && x.state ? { ...x, state: transient ? "sending" : "failed" } : x)));
      }
    },
    [request, peerId],
  );

  const send = async (text: string) => {
    if (!me) return false;
    const clientId = newClientId();
    const item: Item = {
      id: `local-${clientId}`,
      clientId,
      fromId: me.id,
      fromName: me.name,
      fromColor: me.color,
      toId: peerId,
      text,
      createdAt: Date.now(),
      state: "sending",
    };
    stickToBottom.current = true;
    smoothNext.current = true;
    setUnseenBelow(0);
    setMessages((list) => [...(list ?? []), item]);
    if (connected) void deliver(item);
    return true; // composer clears immediately
  };

  const retry = (m: Item) => {
    setMessages((list) => (list ?? []).map((x) => (x.clientId === m.clientId ? { ...x, state: "sending" } : x)));
    if (connected) void deliver({ ...m, state: "sending" });
  };

  // flush anything queued while offline as soon as the socket is back; the server dedupes by clientId
  // (a send whose ack was lost isn't stored twice) and the clientId swap keeps the bubble in place
  useEffect(() => {
    if (!connected) return;
    for (const m of messagesRef.current ?? []) if (m.state === "sending") void deliver(m);
  }, [connected, deliver]);

  const onTyping = () => {
    const now = Date.now();
    if (now - lastTypingSent.current > 2500) {
      lastTypingSent.current = now;
      socket?.emit("dm:typing", { to: peerId });
    }
  };

  const rows = useMemo(() => {
    if (!messages) return [];
    return messages.map((m, i) => {
      const prev = messages[i - 1];
      const next = messages[i + 1];
      const gap = !prev || m.createdAt - prev.createdAt > TIME_GAP_MS || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
      const nextGap = !next || next.createdAt - m.createdAt > TIME_GAP_MS || new Date(next.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
      const first = gap || prev.fromId !== m.fromId || m.createdAt - prev.createdAt > GROUP_WINDOW_MS;
      const last = nextGap || next.fromId !== m.fromId || next.createdAt - m.createdAt > GROUP_WINDOW_MS;
      return { m, gap, first, last };
    });
  }, [messages]);

  const lastMineIdx = useMemo(() => {
    if (!messages || !me) return -1;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].fromId === me.id) return i;
    return -1;
  }, [messages, me]);

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

  const status = offline ? (
    <span className="text-zinc-500">Offline · will send when you&apos;re back</span>
  ) : peerTyping ? (
    <span className="text-emerald-400">typing…</span>
  ) : peer?.isBot ? (
    "Demo user · replies automatically"
  ) : presence.status === "online" ? (
    <span className="text-emerald-400">Online</span>
  ) : presence.status === "away" ? (
    <span className="text-amber-400">Away</span>
  ) : (
    (presence.label ?? `@${peer?.username ?? ""}`)
  );

  return (
    <div className={cn("flex flex-col bg-app", className)} data-testid="dm-thread">
      <header data-app-header className="flex h-16 shrink-0 items-center gap-1 border-b border-white/5 px-2">
        <button onClick={onBack} className="rounded-full p-2 text-zinc-300 hover:bg-white/5" aria-label={backStyle === "close" ? "Close" : "Back to messages"}>
          {backStyle === "close" ? <X className="h-5 w-5" /> : <ChevronLeft className="h-6 w-6" />}
        </button>
        {peer ? (
          <Link href={`/profile/${peer.id}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 hover:bg-white/5">
            <Avatar name={peer.name} color={peer.color} photo={peer.photoUrl} size="sm" presence={peer.isBot ? null : presence.dot} />
            <div className="min-w-0">
              <div className="truncate text-[15px] leading-tight font-semibold">{peer.name}</div>
              <div className="truncate text-xs leading-tight text-zinc-500" data-testid="dm-status">
                {status}
              </div>
            </div>
          </Link>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3 p-1" aria-hidden>
            <div className="openlounge-hex h-10 w-10 animate-pulse bg-zinc-800" />
            <div className="h-3 w-28 animate-pulse rounded-full bg-zinc-800" />
          </div>
        )}
        {peer && (
          <div className="pr-2">
            <FollowButton userId={peer.id} small />
          </div>
        )}
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
            stickToBottom.current = near;
            if (near && unseenBelow) setUnseenBelow(0);
          }}
          className="flex h-full flex-col overflow-y-auto overscroll-contain px-3 pt-3 pb-2 [overflow-anchor:none]"
          data-testid="dm-list"
        >
          {/* pushes a short conversation to the bottom, like every chat app */}
          <div className="flex-1" />
          {messages === null ? (
            <div className="flex justify-center py-16 text-zinc-500">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <>
              {hasMore && (
                <div className="mb-2 flex justify-center">
                  <button onClick={loadEarlier} className="rounded-full px-4 py-1.5 text-xs text-zinc-500 hover:bg-white/5">
                    {loadingMore ? "Loading…" : "Load earlier messages"}
                  </button>
                </div>
              )}
              {peer && !hasMore && (
                <div className="flex flex-col items-center gap-2 pt-6 pb-8 text-center">
                  <Avatar name={peer.name} color={peer.color} photo={peer.photoUrl} size="lg" presence={peer.isBot ? null : presence.dot} />
                  <div className="mt-1 text-[17px] font-semibold">{peer.name}</div>
                  <div className="text-xs text-zinc-500">@{peer.username}</div>
                  {messages.length === 0 && (
                    <p className="mt-1 max-w-xs text-sm text-zinc-500">{peer.bio || "Say hi 👋 — messages are delivered instantly."}</p>
                  )}
                </div>
              )}
              {rows.map(({ m, gap, first, last }, i) => (
                <MessageRow
                  key={keyOf(m)}
                  m={m}
                  mine={m.fromId === me?.id}
                  gap={gap}
                  first={first}
                  last={last}
                  peer={peer}
                  showStatus={i === lastMineIdx || !!m.state}
                  onRetry={retry}
                />
              ))}
              {peerTyping && peer && (
                <div className="msg-in mt-2 flex items-end gap-2" data-testid="dm-typing">
                  <Avatar name={peer.name} color={peer.color} photo={peer.photoUrl} size="xs" />
                  <div className="flex items-center gap-1 rounded-[20px] rounded-bl-md bg-zinc-800 px-4 py-3" aria-label={`${firstName(peer.name)} is typing`}>
                    <span className="typing-dot h-1.5 w-1.5 rounded-full bg-zinc-400" />
                    <span className="typing-dot h-1.5 w-1.5 rounded-full bg-zinc-400 [animation-delay:150ms]" />
                    <span className="typing-dot h-1.5 w-1.5 rounded-full bg-zinc-400 [animation-delay:300ms]" />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        {unseenBelow > 0 && (
          <button
            onClick={scrollToBottom}
            className="fade-in absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-zinc-900 px-3.5 py-1.5 text-xs font-semibold text-zinc-100 shadow-lg ring-1 ring-white/10"
          >
            <ArrowDown className="h-3.5 w-3.5" /> {unseenBelow === 1 ? "New message" : `${unseenBelow} new messages`}
          </button>
        )}
      </div>

      <div className="shrink-0 border-t border-white/5 bg-app px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <ChatComposer
          onSend={send}
          onTyping={onTyping}
          disabled={messages === null}
          placeholder={peer ? `Message ${firstName(peer.name)}…` : "Message…"}
          autoFocus
        />
      </div>
    </div>
  );
}

const MessageRow = memo(function MessageRow({
  m,
  mine,
  gap,
  first,
  last,
  peer,
  showStatus,
  onRetry,
}: {
  m: Item;
  mine: boolean;
  gap: boolean;
  first: boolean;
  last: boolean;
  peer: PublicUser | null;
  showStatus: boolean;
  onRetry: (m: Item) => void;
}) {
  const emoji = EMOJI_ONLY.test(m.text.trim());
  // grouped bubble corners: the "tail" side squares off between messages of the same group
  const shape = mine
    ? cn("rounded-[20px]", !first && "rounded-tr-md", !last && "rounded-br-md")
    : cn("rounded-[20px]", !first && "rounded-tl-md", !last && "rounded-bl-md");
  return (
    <div data-testid="dm-msg" data-mine={mine ? "1" : "0"}>
      {gap && <div className="mt-4 mb-2 text-center text-[11px] font-medium text-zinc-500">{timeLabel(m.createdAt)}</div>}
      <div className={cn("flex items-end gap-2", mine ? "justify-end pl-12" : "justify-start pr-12", first ? "mt-2" : "mt-[3px]")}>
        {!mine && (
          <div className="w-7 shrink-0">
            {last && peer && <Avatar name={peer.name} color={peer.color} photo={peer.photoUrl} size="xs" />}
          </div>
        )}
        <div
          title={formatClock(m.createdAt)}
          className={cn(
            "min-w-0 text-[15px] leading-[1.35] whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
            "msg-in",
            emoji
              ? "px-1 text-[40px] leading-tight"
              : cn("px-3.5 py-2", shape, mine ? "bg-emerald-500 text-on-accent" : "bg-zinc-800 text-zinc-100"),
            m.state === "sending" && "opacity-70",
            m.state === "failed" && "opacity-60",
          )}
        >
          {m.text}
        </div>
      </div>
      {mine && showStatus && (
        <div className="mt-1 pr-1 text-right text-[11px] text-zinc-500">
          {m.state === "failed" ? (
            <button onClick={() => onRetry(m)} className="inline-flex items-center gap-1 text-red-400 hover:underline">
              <RotateCcw className="h-3 w-3" /> Not sent · Tap to retry
            </button>
          ) : m.state === "sending" ? (
            "Sending…"
          ) : (
            "Sent"
          )}
        </div>
      )}
    </div>
  );
});
