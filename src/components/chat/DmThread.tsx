"use client";

import { DELETED_COMPOSER_TEXT, displayUser, useDeletedIds } from "@/lib/userDisplay";
import { friendlyMessage, isTransient } from "@/lib/errors";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, Ban, ChevronLeft, Flag, Loader2, MoreHorizontal, Trash2, X } from "lucide-react";
import { Sheet } from "../Sheet";
import { ReportSheet } from "../safety/ReportSheet";
import { BlockConfirm } from "../safety/BlockConfirm";
import { useSafety, type ReportTarget } from "@/lib/safety";
import type { DirectMessage, DmReadReceipt, PublicUser } from "@/lib/types";
import { NATIVE_VISIBILITY_EVENT, appVisible } from "@/lib/realtime";
import { cn, firstName } from "@/lib/utils";
import { useApp } from "../AppProvider";
import { Avatar } from "../Avatar";
import { ChatComposer } from "./ChatComposer";
import { RemoveChatConfirm, removeLabel } from "./ChatActions";
import { StickerMessage } from "../stickers/StickerMessage";
import { parseSticker } from "@/lib/stickers/token";
import { TypingLabel } from "./TypingDots";
import { dayDiff, formatClock, formatDaySeparator, formatFull, formatListTime, serverNow, useClockTick } from "@/lib/time";
import { FollowButton } from "../UserRow";
import { usePresence } from "@/hooks/usePresence";
import { useRoomCards } from "@/hooks/useRoomCards";
import { roomIdsInText } from "@/lib/roomLinks";
import { RoomCardRow, RoomLinkCards } from "../rooms/RoomJoinCard";
import { DmRoomActions } from "../rooms/DmRoomActions";
import { DropInBanner } from "../rooms/DropInBanner";
import { canAdmin, isGroupId, type ConvMessage, type GroupInfo } from "@/lib/groups";
import { MentionPicker, MentionText, PinnedBar, ServiceRow, jumpToMessage, memberLine, senderPeer, useGroupInfo } from "../groups/GroupBits";

const TYPING_SEND_EVERY_MS = 3_000;
const TYPING_IDLE_MS = 5_000;
const TYPING_SHOW_MS = 6_000;

/** Consecutive messages from the same person within this window form one group (one avatar, tight spacing). */
const RENDER_WINDOW = 200;
const GROUP_WINDOW_MS = 3 * 60_000;
/** A quiet gap this long gets a centred time label (Clubhouse / iMessage style) instead of per-message stamps. */
const TIME_GAP_MS = 15 * 60_000;
const NEAR_BOTTOM_PX = 80;

/** A message on screen: confirmed by the server, or an optimistic one still in flight / failed. */
type Item = DirectMessage & {
  state?: "sending" | "failed";
  /** failed because it stalled offline / timed out (not rejected): re-sent automatically on reconnect too */
  autoRetry?: boolean;
};

/** A send still unacknowledged after this long shows the quiet retry affordance instead of "Sending…". */
const SEND_STALL_MS = 12_000;

/** Stable React key: the client id survives the optimistic → confirmed swap, so the bubble never re-mounts. */
const keyOf = (m: Item) => m.clientId ?? m.id;

/**
 * Separator above a message (device timezone, locale 12/24 h): a new calendar day → "Today 9:24 PM",
 * "Yesterday 8:10 PM", "Monday 3:02 PM", "September 4 1:00 PM"; a quiet gap within the same day → "9:24 PM".
 */
function separatorLabel(ts: number, newDay: boolean) {
  return newDay ? `${formatDaySeparator(ts)} ${formatClock(ts)}` : formatClock(ts);
}

/** "Seen 9:24 PM" today; "Seen Yesterday" / "Seen Mon" / "Seen Sep 4" for older ones (same formatter as the inbox). */
function seenLabel(readAt: number) {
  return `Seen ${dayDiff(readAt) <= 0 ? formatClock(readAt) : formatListTime(readAt)}`;
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

/** Apply a read receipt: messages from `fromId` to `toId` up to `upToMessageId` were seen at `readAt`. */
function applyReceipt(list: Item[], fromId: string, toId: string, upToMessageId: string, readAt: number): Item[] {
  return applySeen(list, fromId, toId, receiptLimit(list, upToMessageId, readAt), readAt);
}

/** Newest createdAt a receipt covers: the target message's time if we have it, else "anything sent before readAt". */
function receiptLimit(list: Item[], upToMessageId: string, readAt: number) {
  const m = list.find((x) => x.id === upToMessageId);
  return m ? m.createdAt : readAt;
}

/** Idempotent + monotonic: only confirmed messages without a readAt are stamped; an existing readAt never changes. */
function applySeen(list: Item[], fromId: string, toId: string, limit: number, readAt: number): Item[] {
  let changed = false;
  const next = list.map((m) => {
    if (m.state || m.readAt || m.fromId !== fromId || m.toId !== toId || m.createdAt > limit) return m;
    changed = true;
    return { ...m, readAt };
  });
  return changed ? next : list;
}

/** Merge server messages into the list: dedupe by id / clientId, keep optimistic ones, keep order. */
function mergeMessages(list: Item[], incoming: DirectMessage[]): Item[] {
  let next = list;
  for (const m of incoming) {
    const i = next.findIndex((x) => x.id === m.id || (!!m.clientId && x.clientId === m.clientId));
    if (i >= 0) {
      if (next[i].state || next[i].id !== m.id) {
        next = next === list ? [...list] : next;
        // swap in place (same key → no flicker); never lose a read receipt we already have
        next[i] = { ...m, clientId: next[i].clientId ?? m.clientId, readAt: m.readAt ?? next[i].readAt ?? null };
      } else if (m.readAt && !next[i].readAt) {
        next = next === list ? [...list] : next;
        next[i] = { ...next[i], readAt: m.readAt }; // seen while we were away (history refetch after reconnect)
      }
      continue;
    }
    next = next === list ? [...list] : next;
    // confirmed messages go before any still-pending ones of mine, in time order
    let at = next.length;
    // ordered by server timestamp, then id (never by the device clock); optimistic ones stay last
    while (at > 0 && (next[at - 1].state || next[at - 1].createdAt > m.createdAt || (next[at - 1].createdAt === m.createdAt && next[at - 1].id > m.id))) at--;
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
  const { socket, connected, offline, me, request, setActiveDm, toast } = useApp();
  const safety = useSafety(me?.id);
  const [moreOpen, setMoreOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false); // "Remove chat" / "Delete chat" for me (unpin + read + hide)
  const [reportTarget, setReportTarget] = useState<ReportTarget | null>(null);
  const [blockOpen, setBlockOpen] = useState(false);
  const iBlocked = safety.isBlocked(peerId);
  const hiddenPeer = safety.isHidden(peerId);
  const onReportMessage = useCallback((m: Item) => setReportTarget({ type: "dm", id: m.id, label: m.text }), []);
  const [peer, setPeer] = useState<PublicUser | null>(null);
  const [messages, setMessages] = useState<Item[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  // store compliance: the peer deleted their account while this thread is open → flip to the ghost live
  const deletedIds = useDeletedIds();
  useEffect(() => {
    if (peer && !peer.deleted && deletedIds.has(peer.id)) setPeer(displayUser(peer));
  }, [deletedIds, peer]);
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

  // ---- group mode: peerId is a "g_…" conversation id. Same pipeline (dm:history / dm:send / dm:read / typing);
  // a few group-only extras: sender names + avatars, service rows, pinned bar, @mentions, admin pin/delete.
  const isGroup = isGroupId(peerId);
  const { presenceOf } = useApp();
  const { group, setGroup, gone } = useGroupInfo(isGroup ? peerId : null, false);
  const memberMap = useMemo(() => new Map((group?.members ?? []).map((x) => [x.id, x])), [group]);
  const amAdmin = canAdmin(group?.myRole);
  const [typers, setTypers] = useState<{ id: string; name: string; color: string; photoUrl: string | null }[]>([]);
  const typerTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // one stable "peer" object per sender so memoized rows don't re-render on every update
  const senderOf = useMemo(() => {
    const cache = new Map<string, PublicUser>();
    return (m: DirectMessage) => {
      let p = cache.get(m.fromId);
      if (!p) cache.set(m.fromId, (p = senderPeer(m, memberMap)));
      return p;
    };
  }, [memberMap]);
  const typingPeer: PublicUser | null = isGroup
    ? typers[0]
      ? senderOf({ id: "", fromId: typers[0].id, fromName: typers[0].name, fromColor: typers[0].color, fromPhotoUrl: typers[0].photoUrl, toId: peerId, text: "", createdAt: 0 })
      : null
    : peer;
  const typingNames = !isGroup || !typers.length ? null : typers.length === 1 ? firstName(typers[0].name) : typers.length === 2 ? `${firstName(typers[0].name)} and ${firstName(typers[1].name)}` : `${firstName(typers[0].name)} and ${typers.length - 1} others`;
  const groupRow = useMemo<GroupRowCtx | undefined>(
    () =>
      isGroup
        ? {
            meUsername: me?.username,
            amAdmin,
            pinned: new Set((group?.pins ?? []).map((p) => p.messageId)),
            onPin: (m, pinned) =>
              void request("group:pin", { id: peerId, messageId: m.id, pinned })
                .then(() => toast(pinned ? "Message pinned" : "Message unpinned"))
                .catch((e: Error) => toast(friendlyMessage(e, "Couldn't pin that message"))),
            onDelete: (m) =>
              void request("group:deleteMessage", { id: peerId, messageId: m.id })
                .then(() => setMessages((list) => (list ? list.filter((x) => x.id !== m.id) : list)))
                .catch((e: Error) => toast(friendlyMessage(e, "Couldn't delete that message"))),
          }
        : undefined,
    [isGroup, me?.username, amAdmin, group?.pins, request, peerId, toast],
  );

  // Read receipts: tell the server only when the thread is really on screen (page/app visible, thread open)
  // and there is something from the peer we haven't marked seen yet.
  const markRead = useCallback(() => {
    if (!socket || !appVisible()) return;
    const list = messagesRef.current ?? [];
    let upTo: Item | null = null;
    for (let i = list.length - 1; i >= 0; i--) {
      if ((isGroup ? list[i].fromId !== me?.id : list[i].fromId === peerId) && !list[i].state) {
        upTo = list[i];
        break;
      }
    }
    if (!upTo) return;
    // groups: readAt means "seen by someone", so only the cursor (last marked id) tells us we are done
    if (isGroup ? lastMarked.current.id === upTo.id : list.every((m) => m.fromId !== peerId || !!m.readAt)) return;
    const now = Date.now();
    if (lastMarked.current.id === upTo.id && now - lastMarked.current.at < 4_000) return; // receipt on its way
    lastMarked.current = { id: upTo.id, at: now };
    socket.emit("dm:read", { peerId, upToMessageId: upTo.id });
  }, [socket, peerId, isGroup, me?.id]);
  const lastMarked = useRef<{ id: string; at: number }>({ id: "", at: 0 });

  // whenever the visible list changes (history loaded, new message, reconnect refresh) → maybe mark seen
  useEffect(() => {
    if (messages?.length) markRead();
  }, [messages, markRead]);

  // Peer's "seen up to" high-water mark (from dm:read-receipt). Re-applied when messages are confirmed later,
  // so a receipt that arrived before the ack/echo still ends at ✓✓. Never moves backwards.
  const peerSeen = useRef<{ limit: number; readAt: number } | null>(null);
  const pendingSeen = useRef<DmReadReceipt | null>(null);
  useEffect(() => {
    const p = pendingSeen.current;
    const target = p && messages?.find((x) => x.id === p.upToMessageId);
    if (p && target) {
      pendingSeen.current = null;
      if (!peerSeen.current || target.createdAt > peerSeen.current.limit) peerSeen.current = { limit: target.createdAt, readAt: p.readAt };
    }
    const mark = peerSeen.current;
    if (!messages || !mark || !me) return;
    if (!messages.some((m) => !m.state && !m.readAt && m.fromId === me.id && m.toId === peerId && m.createdAt <= mark.limit)) return;
    setMessages((list) => (list ? applySeen(list, me.id, peerId, mark.limit, mark.readAt) : list));
  }, [messages, me, peerId]);

  // reset when switching threads (drawer reuse)
  useEffect(() => {
    loadedFor.current = null;
    peerSeen.current = null;
    pendingSeen.current = null;
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
    request<{ peer: PublicUser; messages: DirectMessage[]; hasMore: boolean; group?: GroupInfo }>("dm:history", { peerId })
      .then((r) => {
        setPeer(r.peer);
        if (r.group) setGroup(r.group);
        // keep anything that arrived live / was sent while the fetch was in flight
        setMessages((list) => mergeMessages(r.messages, list ?? []));
        setHasMore(r.hasMore);
        stickToBottom.current = true;
      })
      .catch((e: Error) => {
        loadedFor.current = null; // retry on the next (re)connect
        if (!isTransient(e)) setError(friendlyMessage(e, "Couldn't load this conversation. Try again."));
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
      const inThread = isGroupId(peerId) ? m.toId === peerId : (m.fromId === peerId && m.toId === me?.id) || (m.fromId === me?.id && m.toId === peerId);
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
      }
    };
    const onReceipt = (r: DmReadReceipt) => {
      if (!me) return;
      if (r.readerId === peerId && r.peerId === me.id) {
        // remember the high-water mark: the receipt can overtake the ack/echo of the very message it covers
        // (both threads open → seen fires immediately); it's re-applied once that message is confirmed
        const target = (messagesRef.current ?? []).find((x) => x.id === r.upToMessageId);
        const cur = peerSeen.current;
        if (!target) pendingSeen.current = r; // resolved once that message shows up (ack / echo / refetch)
        else if (!cur || target.createdAt > cur.limit) peerSeen.current = { limit: target.createdAt, readAt: r.readAt };
      }
      // peer saw my messages → ✓✓ ; I saw theirs on another device → keep local state in sync
      if (r.readerId === peerId && r.peerId === me.id)
        setMessages((list) => (list && list.some((x) => x.id === r.upToMessageId) ? applyReceipt(list, me.id, peerId, r.upToMessageId, r.readAt) : list));
      else if (r.readerId === me.id && r.peerId === peerId) setMessages((list) => (list ? applyReceipt(list, peerId, me.id, r.upToMessageId, r.readAt) : list));
    };
    const onTyping = ({ from }: { from: string }) => {
      if (from !== peerId) return;
      const el = listRef.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) stickToBottom.current = true;
      setPeerTyping(true);
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => setPeerTyping(false), TYPING_SHOW_MS);
    };
    const onVisible = () => appVisible() && markRead();
    socket.on("dm:message", onMsg);
    const onTypingStopIn = ({ from }: { from: string }) => {
      if (from !== peerId) return;
      if (typingTimer.current) clearTimeout(typingTimer.current);
      setPeerTyping(false);
    };
    socket.on("dm:typing", onTyping);
    socket.on("dm:typing_stop", onTypingStopIn);
    socket.on("dm:read-receipt", onReceipt);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(NATIVE_VISIBILITY_EVENT, onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      socket.off("dm:message", onMsg);
      socket.off("dm:typing", onTyping);
      socket.off("dm:typing_stop", onTypingStopIn);
      socket.off("dm:read-receipt", onReceipt);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(NATIVE_VISIBILITY_EVENT, onVisible);
      window.removeEventListener("focus", onVisible);
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, [socket, peerId, me, markRead]);

  // group: who's typing (conv:typing — a separate event so older clients never show it in a 1:1) and deletions
  useEffect(() => {
    if (!socket || !isGroup) return;
    const timers = typerTimers.current;
    const drop = (id: string) => {
      clearTimeout(timers.get(id));
      timers.delete(id);
      setTypers((t) => (t.some((x) => x.id === id) ? t.filter((x) => x.id !== id) : t));
    };
    const onConvTyping = (d: { conversationId: string; from: string; name?: string; color?: string; photoUrl?: string | null }) => {
      if (d.conversationId !== peerId || d.from === me?.id) return;
      const el = listRef.current;
      if (el && el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) stickToBottom.current = true;
      setTypers((t) => (t.some((x) => x.id === d.from) ? t : [...t, { id: d.from, name: d.name ?? "Someone", color: d.color ?? "#64748B", photoUrl: d.photoUrl ?? null }]));
      clearTimeout(timers.get(d.from));
      timers.set(d.from, setTimeout(() => drop(d.from), TYPING_SHOW_MS));
    };
    const onConvStop = (d: { conversationId: string; from: string }) => d.conversationId === peerId && drop(d.from);
    const onGroupMsg = (m: DirectMessage) => m.toId === peerId && drop(m.fromId);
    const onDeleted = (d: { conversationId: string; messageId: string }) =>
      d.conversationId === peerId && setMessages((list) => (list ? list.filter((x) => x.id !== d.messageId) : list));
    socket.on("conv:typing", onConvTyping);
    socket.on("conv:typing_stop", onConvStop);
    socket.on("dm:message", onGroupMsg);
    socket.on("conv:deleted", onDeleted);
    return () => {
      socket.off("conv:typing", onConvTyping);
      socket.off("conv:typing_stop", onConvStop);
      socket.off("dm:message", onGroupMsg);
      socket.off("conv:deleted", onDeleted);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      setTypers([]);
    };
  }, [socket, isGroup, peerId, me?.id]);
  useEffect(() => {
    if (isGroup) setPeerTyping(typers.length > 0);
  }, [isGroup, typers.length]);
  // renamed / new photo (group:update) → header follows
  useEffect(() => {
    if (!isGroup || !group) return;
    setPeer((p) => (p && (p.name !== group.title || p.photoUrl !== group.photoUrl || p.color !== group.color) ? { ...p, name: group.title, photoUrl: group.photoUrl, color: group.color, bio: group.description } : p));
  }, [isGroup, group]);

  // Back online with the thread already loaded: refresh the latest page so receipts (and anything the
  // catch-up didn't replay) that happened while we were away show up — state survives reconnects.
  // socket dropped → the peer's typing state is unknown: hide it
  useEffect(() => {
    if (!connected) setPeerTyping(false);
  }, [connected]);

  const wasConnected = useRef(connected);
  useEffect(() => {
    const was = wasConnected.current;
    wasConnected.current = connected;
    if (!connected || was || loadedFor.current !== peerId) return;
    request<{ messages: DirectMessage[]; hasMore: boolean; group?: GroupInfo }>("dm:history", { peerId })
      .then((r) => {
        if (r.group) setGroup(r.group);
        setMessages((list) => mergeMessages(list ?? [], r.messages));
      })
      .catch(() => {
        /* next reconnect tries again */
      });
  }, [connected, peerId, request, markRead]);

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
  // A send that hasn't been acked after SEND_STALL_MS turns into a quiet "Not delivered · Retry" (never a
  // banner); it is still re-sent automatically when the socket comes back (the server dedupes by clientId).
  const stallTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const armStall = useCallback((clientId: string) => {
    const timers = stallTimers.current;
    const old = timers.get(clientId);
    if (old) clearTimeout(old);
    timers.set(
      clientId,
      setTimeout(() => {
        timers.delete(clientId);
        setMessages((list) => (list ?? []).map((x) => (x.clientId === clientId && x.state === "sending" ? { ...x, state: "failed", autoRetry: true } : x)));
      }, SEND_STALL_MS),
    );
  }, []);
  useEffect(() => {
    const timers = stallTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const deliver = useCallback(
    async (item: Item) => {
      try {
        const r = await request<{ message: DirectMessage }>("dm:send", { to: peerId, text: item.text, clientId: item.clientId });
        if (item.clientId) {
          clearTimeout(stallTimers.current.get(item.clientId));
          stallTimers.current.delete(item.clientId);
        }
        setMessages((list) => mergeMessages(list ?? [], [{ ...r.message, clientId: item.clientId }]));
      } catch (e) {
        // dropped connection: stays "sending" and is re-sent on reconnect; real errors → failed (tap to retry)
        const transient = isTransient(e);
        if (!transient && item.clientId) {
          clearTimeout(stallTimers.current.get(item.clientId));
          stallTimers.current.delete(item.clientId);
        }
        setMessages((list) => (list ?? []).map((x) => (x.clientId === item.clientId && x.state === "sending" && !transient ? { ...x, state: "failed", autoRetry: false } : x)));
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
      createdAt: serverNow(), // display only; the server stamps the real createdAt
      state: "sending",
    };
    stickToBottom.current = true;
    smoothNext.current = true;
    setUnseenBelow(0);
    setMessages((list) => [...(list ?? []), item]);
    armStall(clientId);
    if (connected) void deliver(item);
    return true; // composer clears immediately
  };

  const retry = (m: Item) => {
    setMessages((list) => (list ?? []).map((x) => (x.clientId === m.clientId && x.state === "failed" ? { ...x, state: "sending", autoRetry: undefined } : x)));
    if (m.clientId) armStall(m.clientId);
    if (connected) void deliver({ ...m, state: "sending" });
  };

  // flush anything queued while offline as soon as the socket is back; the server dedupes by clientId
  // (a send whose ack was lost isn't stored twice) and the clientId swap keeps the bubble in place
  useEffect(() => {
    if (!connected) return;
    const queued = (messagesRef.current ?? []).filter((m) => m.state === "sending" || (m.state === "failed" && m.autoRetry));
    if (!queued.length) return;
    const ids = new Set(queued.map((m) => m.clientId));
    setMessages((list) => (list ?? []).map((x) => (ids.has(x.clientId) && x.state === "failed" ? { ...x, state: "sending", autoRetry: undefined } : x)));
    for (const m of queued) {
      if (m.clientId) armStall(m.clientId);
      void deliver({ ...m, state: "sending" });
    }
  }, [connected, deliver, armStall]);

  // Outgoing typing state: "dm:typing" at most every ~3s while typing; "dm:typing_stop" on send, blur,
  // clear, 5s idle, or leaving the thread (only if a "typing" went out since the last stop).
  const typingActive = useRef(false);
  const typingIdle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTypingStop = useCallback(() => {
    if (typingIdle.current) clearTimeout(typingIdle.current);
    typingIdle.current = null;
    if (!typingActive.current) return;
    typingActive.current = false;
    lastTypingSent.current = 0;
    socket?.emit("dm:typing_stop", { to: peerId });
  }, [socket, peerId]);
  const onTyping = () => {
    const now = Date.now();
    if (now - lastTypingSent.current >= TYPING_SEND_EVERY_MS) {
      lastTypingSent.current = now;
      typingActive.current = true;
      socket?.emit("dm:typing", { to: peerId });
    }
    if (typingIdle.current) clearTimeout(typingIdle.current);
    typingIdle.current = setTimeout(onTypingStop, TYPING_IDLE_MS);
  };
  useEffect(() => onTypingStop, [onTypingStop]);

  // minute tick / foreground / timezone change → separators ("Today" → "Yesterday" at midnight) re-render
  const clockTick = useClockTick();
  const rows = useMemo(() => {
    if (!messages) return [];
    return messages.map((m, i) => {
      const prev = messages[i - 1];
      const next = messages[i + 1];
      const newDay = !prev || dayDiff(prev.createdAt, m.createdAt) !== 0;
      const gap = newDay || m.createdAt - prev.createdAt > TIME_GAP_MS;
      const nextGap = !next || next.createdAt - m.createdAt > TIME_GAP_MS || dayDiff(m.createdAt, next.createdAt) !== 0;
      const first = gap || prev.fromId !== m.fromId || m.createdAt - prev.createdAt > GROUP_WINDOW_MS;
      const last = nextGap || next.fromId !== m.fromId || next.createdAt - m.createdAt > GROUP_WINDOW_MS;
      return { m, sep: gap ? separatorLabel(m.createdAt, newDay) : null, newDay, first, last };
    });
  }, [messages, clockTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // memory/DOM cap: long threads render only the newest RENDER_WINDOW rows ("Show earlier" grows it)
  const [renderWindow, setRenderWindow] = useState(RENDER_WINDOW);
  const rowOffset = Math.max(0, rows.length - renderWindow);
  const visibleRows = rowOffset ? rows.slice(rowOffset) : rows;

  const lastMineIdx = useMemo(() => {
    if (!messages || !me) return -1;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].fromId === me.id) return i;
    return -1;
  }, [messages, me]);

  // audio room cards: invite / drop-in messages + pasted openlounge.app/room links → live state over the socket
  const linkIds = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const x of messages ?? []) if (!x.kind) {
      const ids = roomIdsInText(x.text);
      if (ids.length) m.set(keyOf(x), ids);
    }
    return m;
  }, [messages]);
  const cardIds = useMemo(() => {
    const set = new Set<string>();
    for (const x of messages ?? []) if (x.kind && x.roomId) set.add(x.roomId);
    for (const ids of linkIds.values()) for (const id of ids) set.add(id);
    return [...set];
  }, [messages, linkIds]);
  const roomCards = useRoomCards(socket, connected, cardIds);
  const latestDropIn = useMemo(() => {
    for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) if (messages![i].kind === "dropin" && messages![i].roomId) return messages![i].roomId!;
    return null;
  }, [messages]);
  const onCardSent = useCallback((m: DirectMessage) => {
    stickToBottom.current = true;
    smoothNext.current = true;
    setMessages((list) => mergeMessages(list ?? [], [m]));
  }, []);

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
    <span className="text-emerald-400">{typingNames ? `${typingNames} ${typers.length > 1 ? "are" : "is"} typing…` : "typing…"}</span>
  ) : isGroup ? (
    <span data-testid="group-members-line">{memberLine(group, presenceOf)}</span>
  ) : peer?.isBot ? (
    "Demo user · replies automatically"
  ) : presence.status === "online" ? (
    <span className="text-emerald-400">Online</span>
  ) : presence.status === "away" ? (
    <span className="text-amber-400">Away</span>
  ) : (
    presence.label ? (
      <span title={presence.seenTitle} data-last-seen={presence.lastSeenAt ?? undefined} data-testid="dm-last-seen">
        {presence.label}
      </span>
    ) : (
      `@${peer?.username ?? ""}`
    )
  );

  return (
    <div className={cn("flex flex-col", className)} data-testid="dm-thread">
      <header data-app-header className="flex h-16 shrink-0 items-center gap-1 border-b border-white/5 px-2">
        <button onClick={onBack} className="rounded-full p-2 text-zinc-300 hover:bg-white/5" aria-label={backStyle === "close" ? "Close" : "Back to messages"}>
          {backStyle === "close" ? <X className="h-5 w-5" /> : <ChevronLeft className="h-6 w-6" />}
        </button>
        {peer ? (
          <Link href={isGroup ? `/groups/${peer.id}` : `/profile/${peer.id}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 hover:bg-white/5" data-testid={isGroup ? "group-header" : undefined}>
            <Avatar name={peer.name} color={peer.color} photo={peer.photoUrl} size="sm" presence={peer.isBot || isGroup ? null : presence.dot} />
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
        {peer && !isGroup && !hiddenPeer && !peer.deleted && (
          <div className="pr-1">
            <FollowButton userId={peer.id} small />
          </div>
        )}
        {peer && !peer.isBot && !isGroup && (
          <button onClick={() => setMoreOpen(true)} className="mr-1 rounded-full p-2 text-zinc-400 hover:bg-white/5 hover:text-zinc-100" aria-label="More options">
            <MoreHorizontal className="h-5 w-5" />
          </button>
        )}
      </header>
      {peer && (
        <>
          <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title={peer.deleted ? peer.name : `@${peer.username}`}>
            <div className="space-y-1">
              {!peer.deleted && (
              <>
              <button
                onClick={() => {
                  setMoreOpen(false);
                  setReportTarget({ type: "user", id: peer.id, label: peer.name });
                }}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium text-red-400 hover:bg-red-500/10"
              >
                <Flag className="h-4 w-4" /> Report @{peer.username}
              </button>
              <button
                onClick={() => {
                  setMoreOpen(false);
                  setBlockOpen(true);
                }}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium text-red-400 hover:bg-red-500/10"
              >
                <Ban className="h-4 w-4" /> {iBlocked ? `Unblock @${peer.username}` : `Block @${peer.username}`}
              </button>
              </>
              )}
              <button
                onClick={() => {
                  setMoreOpen(false);
                  setRemoveOpen(true);
                }}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm font-medium text-red-400 hover:bg-red-500/10"
                data-testid="dm-menu-remove-chat"
              >
                <Trash2 className="h-4 w-4" /> {removeLabel(!!peer.deleted)}
              </button>
              {!peer.deleted && <p className="px-3 pt-2 text-xs text-zinc-500">Tip: press and hold a message to report just that message.</p>}
            </div>
          </Sheet>
          <RemoveChatConfirm peer={removeOpen ? peer : null} onClose={() => setRemoveOpen(false)} onRemoved={() => onBack()} />
          <ReportSheet
            target={reportTarget}
            onClose={() => setReportTarget(null)}
            onBlock={
              iBlocked
                ? undefined
                : () => {
                    setReportTarget(null);
                    setBlockOpen(true);
                  }
            }
          />
          <BlockConfirm
            user={blockOpen ? { id: peer.id, name: peer.name } : null}
            blocked={iBlocked}
            onClose={() => setBlockOpen(false)}
            onDone={(b) => {
              toast(b ? `Blocked ${peer.name}` : `Unblocked ${peer.name}`);
              if (b) setMessages([]);
              else
                request<{ messages: DirectMessage[]; hasMore: boolean }>("dm:history", { peerId })
                  .then((r) => (setMessages(r.messages), setHasMore(r.hasMore)))
                  .catch(() => {});
            }}
          />
        </>
      )}

      {isGroup && group && group.pins.length > 0 && (
        <PinnedBar
          pins={group.pins}
          canUnpin={amAdmin}
          onJump={(id) => {
            stickToBottom.current = false;
            if (!jumpToMessage(listRef.current, id)) toast(hasMore ? "Scroll up to load that message" : "That message is no longer available");
          }}
          onUnpin={(id) => groupRow?.onPin({ id } as Item, false)}
        />
      )}
      {latestDropIn && !hiddenPeer && <DropInBanner card={roomCards.get(latestDropIn) ?? null} meId={me?.id} peerId={peerId} />}
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
                  <Avatar name={peer.name} color={peer.color} photo={peer.photoUrl} size="lg" presence={peer.isBot || isGroup ? null : presence.dot} />
                  <div className="mt-1 text-[17px] font-semibold">{peer.name}</div>
                  <div className="text-xs text-zinc-500">@{peer.username}</div>
                  {messages.length === 0 && (
                    <p className="mt-1 max-w-xs text-sm text-zinc-500">{peer.bio || "Say hi 👋 — messages are delivered instantly."}</p>
                  )}
                </div>
              )}
              {rowOffset > 0 && (
                <button type="button" onClick={() => setRenderWindow((w) => w + RENDER_WINDOW)} className="mx-auto my-2 block rounded-full px-3 py-1 text-xs font-semibold text-zinc-400 hover:bg-white/5">
                  Show earlier messages
                </button>
              )}
              {visibleRows.map(({ m, sep, newDay, first, last }, vi) => { const i = vi + rowOffset; return m.kind && m.roomId ? (
                <RoomCardRow
                  key={keyOf(m)}
                  roomId={m.roomId}
                  card={roomCards.get(m.roomId) ?? null}
                  kind={m.kind}
                  mine={m.fromId === me?.id}
                  sep={sep}
                  sepTitle={formatFull(m.createdAt)}
                  first={first}
                  last={last}
                  peer={isGroup ? senderOf(m) : peer}
                  fromName={m.fromName}
                  pending={!!m.state}
                />
              ) : (m as ConvMessage).service ? (
                <ServiceRow key={keyOf(m)} m={m as ConvMessage} meId={me?.id} members={memberMap} />
              ) : (
                <div key={keyOf(m)} data-mid={m.id}>
                <MessageRow
                  key={keyOf(m)}
                  m={m}
                  mine={m.fromId === me?.id}
                  sep={sep}
                  newDay={newDay}
                  clockTick={clockTick}
                  first={first}
                  last={last}
                  peer={isGroup ? senderOf(m) : peer}
                  group={groupRow}
                  showStatus={i === lastMineIdx || m.state === "failed"}
                  latest={i === lastMineIdx}
                  onRetry={retry}
                  onReport={onReportMessage}
                />
                {linkIds.has(keyOf(m)) && <RoomLinkCards ids={linkIds.get(keyOf(m))!} cards={roomCards} mine={m.fromId === me?.id} />}
                </div>
              ); })}
              {peerTyping && typingPeer && (
                <div className="msg-in mt-2 flex items-end gap-2" data-testid="dm-typing">
                  <Avatar name={typingPeer.name} color={typingPeer.color} photo={typingPeer.photoUrl} size="xs" />
                  <div className="dm-theirs flex items-center gap-1 rounded-[20px] rounded-bl-md bg-zinc-800 px-4 py-3" aria-label={`${typingNames ?? firstName(typingPeer.name)} is typing`}>
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

      <div className="shrink-0 border-t border-white/5 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {isGroup && gone ? (
          <div className="flex items-center justify-center gap-2 py-3 text-center text-sm text-zinc-400" data-testid="group-gone">
            {gone === "left" ? "You left this group." : gone === "removed" ? "You were removed from this group." : "This group is no longer available."}
          </div>
        ) : peer?.deleted ? (
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 py-2 text-center text-sm text-zinc-400" data-testid="dm-deleted">
            <span>{DELETED_COMPOSER_TEXT}</span>
            <button
              type="button"
              onClick={() => setRemoveOpen(true)}
              className="shrink-0 rounded-full border border-red-500/40 px-4 py-1.5 text-sm font-semibold text-red-400 hover:bg-red-500/10"
              data-testid="dm-deleted-remove"
            >
              Remove chat
            </button>
          </div>
        ) : hiddenPeer ? (
          <div className="flex items-center justify-between gap-3 py-2 text-sm text-zinc-400" data-testid="dm-blocked">
            <span className="flex items-center gap-2">
              <Ban className="h-4 w-4 shrink-0 text-red-400" />
              {iBlocked ? `You blocked ${peer ? firstName(peer.name) : "this account"}.` : "You can't message this account."}
            </span>
            {iBlocked && (
              <button onClick={() => setBlockOpen(true)} className="shrink-0 rounded-full border border-white/15 px-4 py-1.5 text-sm font-semibold text-zinc-200 hover:bg-white/5">
                Unblock
              </button>
            )}
          </div>
        ) : (
        <>
        <div className={cn("overflow-hidden px-1 text-[13px] transition-[height,opacity] duration-200 motion-reduce:transition-none", peerTyping && peer ? "h-6 opacity-100" : "h-0 opacity-0")} aria-live="polite">
          {peerTyping && typingPeer && (
            <span className="flex h-6 items-center gap-1.5 text-zinc-400">
              <span className="truncate font-medium text-zinc-300">{typingNames ?? firstName(typingPeer.name)}</span>
              <TypingLabel testId="dm-typing-strip" />
            </span>
          )}
        </div>
        <div className="flex items-end gap-2">
        {peer && !peer.isBot && <DmRoomActions peerId={peerId} peerName={peer.name} disabled={messages === null || offline} onSent={onCardSent} />}
        <div className="min-w-0 flex-1">
        <ChatComposer
          onSend={send}
          onTyping={onTyping}
          onTypingStop={onTypingStop}
          disabled={messages === null}
          placeholder={peer && !isGroup ? `Message ${firstName(peer.name)}…` : "Message…"}
          above={isGroup && group ? (t, set) => <MentionPicker text={t} members={group.members} meId={me?.id} onPick={set} /> : undefined}
          autoFocus
        />
        </div>
        </div>
        </>
        )}
      </div>
    </div>
  );
}

const MessageRow = memo(function MessageRow({
  m,
  mine,
  sep,
  newDay,
  clockTick,
  first,
  last,
  peer,
  showStatus,
  latest,
  onRetry,
  onReport,
  group,
}: {
  m: Item;
  mine: boolean;
  sep: string | null;
  newDay: boolean;
  /** forces a re-render on the minute tick so relative labels ("Seen Yesterday") stay current */
  clockTick: number;
  first: boolean;
  last: boolean;
  peer: PublicUser | null;
  showStatus: boolean;
  latest: boolean;
  onRetry: (m: Item) => void;
  onReport?: (m: Item) => void;
  /** group conversations only: sender names, @mention highlight, admin pin / delete */
  group?: GroupRowCtx;
}) {
  const emoji = EMOJI_ONLY.test(m.text.trim());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const sticker = parseSticker(m.text); // sticker message: large, no bubble
  void clockTick;
  // long-press (touch) or right-click shows the full local date-time + UTC under the bubble for a few seconds
  const [showFull, setShowFull] = useState(false);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (press.current) clearTimeout(press.current);
    if (hide.current) clearTimeout(hide.current);
  }, []);
  const reveal = () => {
    setShowFull(true);
    if (hide.current) clearTimeout(hide.current);
    hide.current = setTimeout(() => setShowFull(false), 4000);
  };
  const cancel = () => {
    if (press.current) clearTimeout(press.current);
    press.current = null;
  };
  const pressHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") return;
      cancel();
      press.current = setTimeout(reveal, 450);
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      cancel();
      reveal();
    },
  };
  // grouped bubble corners: the "tail" side squares off between messages of the same group
  const shape = mine
    ? cn("rounded-[20px]", !first && "rounded-tr-md", !last && "rounded-br-md")
    : cn("rounded-[20px]", !first && "rounded-tl-md", !last && "rounded-bl-md");
  return (
    <div data-testid="dm-msg" data-mine={mine ? "1" : "0"}>
      {sep && (
        <div className="mt-4 mb-2 text-center text-[11px] font-medium text-zinc-500" data-testid={newDay ? "dm-day" : "dm-gap"} title={formatFull(m.createdAt)}>
          {sep}
        </div>
      )}
      {group && !mine && first && peer && (
        <div className="mt-2 -mb-1.5 truncate pl-9 text-[12px] leading-4 font-semibold" style={{ color: peer.color }} data-testid="group-sender">
          {peer.name}
        </div>
      )}
      <div className={cn("flex items-end gap-2", mine ? "justify-end pl-12" : "justify-start pr-12", first ? "mt-2" : "mt-[3px]")}>
        {!mine && (
          <div className="w-7 shrink-0">
            {last && peer && <Avatar name={peer.name} color={peer.color} photo={peer.photoUrl} size="xs" />}
          </div>
        )}
        {mine && <Receipt m={m} onRetry={onRetry} />}
        <div
          title={formatFull(m.createdAt)}
          data-testid="dm-bubble"
          data-ts={m.createdAt}
          {...pressHandlers}
          className={cn(
            "min-w-0 text-[15px] leading-[1.35] whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
            "msg-in",
            sticker
              ? "px-0"
              : emoji
              ? "px-1 text-[40px] leading-tight"
              : cn("px-3.5 py-2", shape, mine ? "bg-emerald-500 text-on-accent" : "dm-theirs bg-zinc-800 text-zinc-100"),
            m.state === "sending" && "opacity-70",
            m.state === "failed" && "opacity-60",
          )}
        >
          {sticker ? <StickerMessage sticker={sticker} pending={m.state === "sending"} /> : group ? <MentionText text={m.text} meUsername={group.meUsername} mine={mine} /> : m.text}
        </div>
      </div>
      {showFull && (
        <div className={cn("fade-in mt-[2px] text-[10.5px] leading-[13px] font-medium text-zinc-500", mine ? "pr-1 text-right" : "pl-9 text-left")} data-testid="dm-fulltime">
          {formatFull(m.createdAt)}
          {!mine && onReport && !m.state && !peer?.isBot && (
            <button
              type="button"
              onClick={() => onReport(m)}
              className="ml-2 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-red-400 hover:bg-red-500/10"
              data-testid="dm-report"
            >
              <Flag className="h-3 w-3" /> Report
            </button>
          )}
          {group && !m.state && group.amAdmin && (
            <button type="button" onClick={() => group.onPin(m, !group.pinned.has(m.id))} className="ml-2 inline-flex items-center rounded-full px-1.5 py-0.5 text-zinc-300 hover:bg-white/5" data-testid="group-pin">
              {group.pinned.has(m.id) ? "Unpin" : "Pin"}
            </button>
          )}
          {group && !m.state && (mine || group.amAdmin) && (
            <button
              type="button"
              onClick={() => (confirmDelete ? group.onDelete(m) : setConfirmDelete(true))}
              className="ml-2 inline-flex items-center rounded-full px-1.5 py-0.5 text-red-400 hover:bg-red-500/10"
              data-testid="group-delete"
            >
              {confirmDelete ? "Delete for everyone?" : "Delete"}
            </button>
          )}
        </div>
      )}
      {mine && showStatus && <StatusLine m={m} latest={latest} onRetry={onRetry} />}
    </div>
  );
});

/** Group-only context for message rows (one memoized object per thread). */
type GroupRowCtx = {
  meUsername?: string;
  amAdmin: boolean;
  pinned: Set<string>;
  onPin: (m: Item, pinned: boolean) => void;
  onDelete: (m: Item) => void;
};

/** Delivery state of one of my messages. Only ever moves forward: sending → sent (server ack, "Delivered") → seen. */
type ReceiptState = "pending" | "failed" | "sent" | "seen";
const receiptState = (m: Item): ReceiptState => (m.state === "sending" ? "pending" : m.state === "failed" ? "failed" : m.readAt ? "seen" : "sent");

/**
 * iMessage-style ticks next to my bubble, pure SVG + CSS (globals.css `.rcpt*`):
 *  - pending: a tiny clock whose hand turns (only appears if the ack takes > 300 ms, so fast sends don't flicker)
 *  - sent:    a single thin check that draws itself in (~240 ms)
 *  - seen:    the second check draws in beside it and the pair shifts to the accent colour
 *  - failed:  a small retry arrow in the same slot (tap to resend) — never an error banner
 * States present when the bubble first renders (history) are shown static; only live transitions animate.
 * Fixed-size slot → no layout shift. prefers-reduced-motion → no motion, instant state changes.
 */
function Receipt({ m, onRetry }: { m: Item; onRetry: (m: Item) => void }) {
  const state = receiptState(m);
  const born = useRef(state);
  const label = state === "pending" ? "Sending" : state === "failed" ? "Not delivered. Retry" : state === "seen" ? seenLabel(m.readAt!) : "Delivered";
  const drawFirst = born.current === "pending" || born.current === "failed";
  const drawSecond = born.current !== "seen";
  if (state === "failed") {
    return (
      <button
        type="button"
        onClick={() => onRetry(m)}
        className="rcpt rcpt-retry relative mb-[3px] inline-flex h-2.5 w-[15px] shrink-0 items-center justify-end self-end text-zinc-400 after:absolute after:-inset-2.5 after:content-[''] hover:text-zinc-200"
        data-receipt="failed"
        title={label}
        aria-label={label}
      >
        <svg viewBox="0 0 16 10" width="15" height="10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="rcpt-pop">
          <path d="M12.2 3.1A3.9 3.9 0 1 0 12.5 6.6" />
          <path d="M12.6 1.1v2.3h-2.3" />
        </svg>
      </button>
    );
  }
  return (
    <span
      className={cn(
        "rcpt mb-[3px] inline-flex h-2.5 w-[15px] shrink-0 items-center justify-end self-end",
        state === "seen" ? "text-emerald-400 opacity-100" : "text-zinc-500 opacity-60",
      )}
      data-receipt={state}
      title={label}
      aria-label={label}
      role="img"
    >
      <svg viewBox="0 0 16 10" width="15" height="10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {state === "pending" ? (
          <g className="rcpt-clock">
            <circle cx="10" cy="5" r="3.9" />
            <path d="M10 5h1.6" />
            <path className="rcpt-hand" d="M10 5V2.6" />
          </g>
        ) : (
          <>
            <path className={cn(drawFirst && "rcpt-draw")} pathLength={1} d="M1.2 5.4l2.9 2.9 5.7-6.6" />
            {state === "seen" && <path className={cn(drawSecond && "rcpt-draw rcpt-draw-late")} pathLength={1} d="M6.7 7l1.3 1.3 5.7-6.6" />}
          </>
        )}
      </svg>
    </span>
  );
}

type StatusDesc = { key: string; state: ReceiptState; readAt: number | null };

function StatusLabel({ d, m, onRetry, inert }: { d: StatusDesc; m: Item; onRetry: (m: Item) => void; inert?: boolean }) {
  if (d.state === "failed")
    return (
      <span>
        Not delivered ·{" "}
        <button type="button" tabIndex={inert ? -1 : 0} onClick={() => onRetry(m)} className="font-semibold text-zinc-300 hover:text-zinc-100">
          Retry
        </button>
      </span>
    );
  if (d.state === "pending") return <span>Sending…</span>;
  if (d.state === "seen" && d.readAt) return <span>{seenLabel(d.readAt)}</span>;
  return <span>Delivered</span>;
}

/**
 * One quiet line under my most recent message (and under any failed one): "Sending…" → "Delivered" →
 * "Seen 9:24 PM". The line height is reserved (no layout shift) and labels crossfade (~180 ms, ease-out).
 * "Sending…" waits 300 ms before fading in, so a normal fast ack goes straight to "Delivered" without flicker.
 */
function StatusLine({ m, latest, onRetry }: { m: Item; latest: boolean; onRetry: (m: Item) => void }) {
  const state = receiptState(m);
  const desc: StatusDesc = { key: state === "seen" ? `seen-${m.readAt}` : state, state, readAt: m.readAt ?? null };
  const shown = useRef(desc);
  const [prev, setPrev] = useState<StatusDesc | null>(null);
  const changed = useRef(false);
  useEffect(() => {
    if (shown.current.key === desc.key) return;
    setPrev(shown.current);
    shown.current = desc;
    changed.current = true;
    const t = setTimeout(() => setPrev(null), 200);
    return () => clearTimeout(t);
  }, [desc.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const inClass = changed.current || prev ? (state === "pending" ? "status-in status-in-late" : "status-in") : state === "pending" ? "status-in status-in-late" : "";
  return (
    <div
      className="mt-[2px] grid h-[13px] justify-items-end pr-1 text-[10.5px] leading-[13px] font-medium tracking-[0.01em] text-zinc-500"
      data-testid="dm-status-line"
      data-state={state}
      aria-live={latest ? "polite" : undefined}
    >
      {prev && prev.key !== desc.key && (
        <div className="status-out pointer-events-none [grid-area:1/1] whitespace-nowrap" aria-hidden>
          <StatusLabel d={prev} m={m} onRetry={onRetry} inert />
        </div>
      )}
      <div key={desc.key} className={cn("[grid-area:1/1] whitespace-nowrap", inClass)}>
        <StatusLabel d={desc} m={m} onRetry={onRetry} />
      </div>
    </div>
  );
}
