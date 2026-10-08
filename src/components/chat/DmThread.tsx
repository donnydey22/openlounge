"use client";

import { DELETED_COMPOSER_TEXT, displayUser, useDeletedIds } from "@/lib/userDisplay";
import { friendlyMessage, isTransient } from "@/lib/errors";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, Ban, CheckCircle2, ChevronLeft, Copy, Flag, Loader2, Maximize2, MoreHorizontal, Pencil, Phone, Pin, Smile, Trash2, Video, X } from "lucide-react";
import { Sheet } from "../Sheet";
import { ReportSheet } from "../safety/ReportSheet";
import { BlockConfirm } from "../safety/BlockConfirm";
import { useSafety, type ReportTarget } from "@/lib/safety";
import { MESSAGE_EDIT_WINDOW_MS, type DirectMessage, type DmReaction, type DmReactionEvent, type DmReadReceipt, type MessageEditedEvent, type PublicUser } from "@/lib/types";
import "./emoji/chat-fx.css";
import { bigEmoji, preloadQuickReactions } from "@/lib/emoji/assets";
import { BigEmoji, bigEmojiSize } from "./emoji/BigEmoji";
import { ReactionChips } from "./emoji/ReactionChips";
import { SponsoredSlot } from "@/components/sponsored/Sponsored";
import { MessageActionOverlay, type MessageAction, type OverlayTarget } from "./emoji/MessageActionOverlay";
import { ReactionFlight, type Flight } from "./emoji/ReactionFlight";
import { burst, dust } from "./emoji/effects";
import { DeleteDialog } from "./DeleteDialog";
import { UNDO_MS, UndoToast } from "./UndoToast";
import { animate, haptic, prefersReducedMotion } from "./emoji/motion";
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
import { CallMessageRow } from "../calls/CallMessageRow";
import { startCall } from "../calls/CallProvider";
import { DropInBanner } from "../rooms/DropInBanner";
import { canAdmin, isGroupId, type ConvMessage, type GroupInfo } from "@/lib/groups";
import { MentionPicker, MentionText, PinnedBar, ServiceRow, jumpToMessage, memberLine, senderPeer, useGroupInfo } from "../groups/GroupBits";
import { MediaBubble, mediaActions } from "../media/MediaBubble";
import { openViewer } from "../media/viewerStore";
import { mediaGone } from "@/lib/media/types";
import { MediaLayer } from "../media/MediaLayer";
import { MediaAttach, MediaVoiceButton, type MediaSendCtx } from "../media/MediaComposer";
import { retryMedia, type QueueCallbacks } from "@/lib/media/outbox";

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

/** Edit is offered on my own sent plain-text messages (no stickers, media, invite / call cards) within the window. */
const canEdit = (m: Item, meId?: string) =>
  !!meId && m.fromId === meId && !m.state && !m.kind && !m.call && !m.media && !m.attachments?.length && !parseSticker(m.text) && serverNow() - m.createdAt < MESSAGE_EDIT_WINDOW_MS;

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

/** Long-press threshold (Telegram ≈ 350 ms) and how far a finger may drift before it counts as a scroll. */
const LONG_PRESS_MS = 350;
const PRESS_SLOP_PX = 10;
const QUICK_REACTION = "❤️";

const sameReactions = (a?: DmReaction[], b?: DmReaction[]) =>
  (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((r, i) => r.emoji === b![i].emoji && r.userId === b![i].userId);

/** Apply a reaction add/remove (idempotent; one reaction per person, like the server). */
function applyReactionEvent(list: Item[], ev: Pick<DmReactionEvent, "messageId" | "userId" | "emoji" | "at">, on: boolean): Item[] {
  const i = list.findIndex((m) => m.id === ev.messageId);
  if (i < 0) return list;
  const cur = list[i].reactions ?? [];
  let next: DmReaction[];
  if (on) {
    if (cur.some((r) => r.userId === ev.userId && r.emoji === ev.emoji)) return list;
    next = [...cur.filter((r) => r.userId !== ev.userId), { emoji: ev.emoji, userId: ev.userId, at: ev.at }];
  } else {
    next = cur.filter((r) => !(r.userId === ev.userId && r.emoji === ev.emoji));
    if (next.length === cur.length) return list;
  }
  const out = [...list];
  out[i] = { ...list[i], reactions: next.length ? next : undefined };
  return out;
}
function setReactions(list: Item[], id: string, reactions: DmReaction[] | undefined): Item[] {
  const i = list.findIndex((m) => m.id === id);
  if (i < 0 || sameReactions(list[i].reactions, reactions)) return list;
  const out = [...list];
  out[i] = { ...list[i], reactions: reactions?.length ? reactions : undefined };
  return out;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

const inViewport = (el: Element | null) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight && r.width > 0;
};

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
        next[i] = { ...next[i], readAt: m.readAt, reactions: m.reactions }; // seen while we were away (history refetch after reconnect)
      } else if (!sameReactions(m.reactions, next[i].reactions)) {
        next = next === list ? [...list] : next;
        next[i] = { ...next[i], reactions: m.reactions }; // reactions changed while we were away
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

  // ---- edit (Telegram): "Edit" in the menu → the composer holds the text → ✓ saves (optimistic, reverted on error) ----
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [flashEdit, setFlashEdit] = useState<Record<string, number>>({});
  const applyEdit = useCallback((messageId: string, patch: { text: string; editedAt?: number; editCount?: number }) => {
    setMessages((list) => (list && list.some((x) => x.id === messageId) ? list.map((x) => (x.id === messageId ? { ...x, ...patch } : x)) : list));
    setFlashEdit((f) => ({ ...f, [messageId]: (f[messageId] ?? 0) + 1 }));
  }, []);
  const saveEdit = useCallback(
    async (text: string) => {
      const cur = editing && messagesRef.current?.find((x) => x.id === editing.id);
      if (!cur) return true;
      const before = { text: cur.text, editedAt: cur.editedAt, editCount: cur.editCount };
      applyEdit(cur.id, { text, editedAt: serverNow(), editCount: (cur.editCount ?? 0) + 1 });
      try {
        const r = await request<{ message: { text: string; editedAt: number | null; editCount: number } }>("dm:edit", { chatId: peerId, messageId: cur.id, text });
        applyEdit(cur.id, { text: r.message.text, editedAt: r.message.editedAt ?? undefined, editCount: r.message.editCount || undefined });
        return true;
      } catch (e) {
        setMessages((list) => (list ? list.map((x) => (x.id === cur.id ? { ...x, ...before } : x)) : list));
        toast(friendlyMessage(e, "Couldn't edit that message"));
        return false;
      }
    },
    [editing, applyEdit, request, peerId, toast],
  );
  useEffect(() => setEditing(null), [peerId]);
  useEffect(() => {
    if (editing && messages && !messages.some((x) => x.id === editing.id)) setEditing(null); // deleted meanwhile
  }, [editing, messages]);
  // edits from the other side / my other devices (1:1: keyed by the other person; groups: the group id)
  useEffect(() => {
    if (!socket) return;
    const onEdited = (d: MessageEditedEvent) => d.conversationId === peerId && applyEdit(d.messageId, { text: d.text, editedAt: d.editedAt, editCount: d.editCount });
    socket.on("message_edited", onEdited);
    return () => {
      socket.off("message_edited", onEdited);
    };
  }, [socket, peerId, applyEdit]);

  // ---- delete (Telegram): dialog → dust + collapse → "Message deleted • Undo" for 5 s → committed on the server ----
  const [delAsk, setDelAsk] = useState<Item[] | null>(null);
  const [pendingDel, setPendingDel] = useState<{ items: Item[]; forEveryone: boolean; at: number } | null>(null);
  const pendingRef = useRef(pendingDel);
  pendingRef.current = pendingDel;
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const restoreItems = useCallback((items: Item[]) => {
    setMessages((list) => {
      if (!list) return list;
      const have = new Set(list.map(keyOf));
      const back = items.filter((m) => !have.has(keyOf(m)));
      return back.length ? [...list, ...back].sort((a, b) => a.createdAt - b.createdAt) : list;
    });
  }, []);
  const commitDelete = useCallback(
    (p: { items: Item[]; forEveryone: boolean }) => {
      const ids = p.items.filter((m) => !m.state).map((m) => m.id); // unsent bubbles only ever lived here
      if (!ids.length) return;
      const fail = (e: Error) => {
        restoreItems(p.items);
        toast(friendlyMessage(e, "Couldn't delete that message"));
      };
      if (isGroup) void Promise.all(ids.map((messageId) => request("group:deleteMessage", { id: peerId, messageId }))).catch(fail);
      else void request("dm:delete", { peerId, messageIds: ids, forEveryone: p.forEveryone }).catch(fail);
    },
    [isGroup, peerId, request, toast, restoreItems],
  );
  // the undo window closes → commit; leaving the chat / closing the page commits right away
  useEffect(() => {
    if (!pendingDel) return;
    const t = setTimeout(() => {
      commitDelete(pendingDel);
      setPendingDel((cur) => (cur === pendingDel ? null : cur));
    }, Math.max(0, UNDO_MS - (Date.now() - pendingDel.at)));
    return () => clearTimeout(t);
  }, [pendingDel, commitDelete]);
  useEffect(() => {
    const flush = () => {
      const p = pendingRef.current;
      if (!p) return;
      pendingRef.current = null;
      commitDelete(p);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [commitDelete]);
  // deleted elsewhere (the peer deleted for everyone, or I did on another device): drop it here too
  useEffect(() => {
    if (!socket || isGroup) return;
    const onDeleted = (d: { conversationId: string; messageId: string }) =>
      d.conversationId === peerId && setMessages((list) => (list && list.some((x) => x.id === d.messageId) ? list.filter((x) => x.id !== d.messageId) : list));
    socket.on("conv:deleted", onDeleted);
    return () => {
      socket.off("conv:deleted", onDeleted);
    };
  }, [socket, isGroup, peerId]);
  /** Telegram's exit: the bubble crumbles to dust, then the row folds away (transform / opacity, then one height) */
  const animateOut = useCallback((items: Item[]) => {
    const root = listRef.current;
    if (!root || prefersReducedMotion()) return Promise.resolve();
    const runs = items.slice(0, 12).map((m) => {
      const row = root.querySelector<HTMLElement>(`[data-testid=dm-msg][data-mid="${CSS.escape(m.id)}"]`);
      const b = row?.querySelector<HTMLElement>("[data-mid-bubble]");
      if (!row || !b) return Promise.resolve();
      const r = b.getBoundingClientRect();
      if (r.bottom > 0 && r.top < window.innerHeight) dust(r, row.dataset.mine === "1");
      const fade = b.animate([{ opacity: 1, transform: "none", filter: "blur(0)" }, { opacity: 0, transform: "scale(0.92) translateX(8px)", filter: "blur(2px)" }], { duration: 220, easing: "ease-in", fill: "forwards" });
      return fade.finished.then(() => {
        const h = row.offsetHeight;
        row.style.overflow = "hidden";
        return row.animate([{ height: `${h}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 160, easing: "cubic-bezier(0.4,0,0.2,1)", fill: "forwards" }).finished.then(() => undefined);
      }).catch(() => undefined);
    });
    return Promise.all(runs).then(() => undefined);
  }, []);
  const confirmDelete = useCallback(
    (forEveryone: boolean) => {
      const items = delAsk;
      setDelAsk(null);
      setSelected(null);
      if (!items?.length) return;
      haptic("medium");
      const prev = pendingRef.current;
      if (prev) {
        pendingRef.current = null;
        setPendingDel(null);
        commitDelete(prev);
      }
      void animateOut(items).then(() => {
        const gone = new Set(items.map(keyOf));
        setMessages((list) => (list ? list.filter((x) => !gone.has(keyOf(x))) : list));
        setPendingDel({ items, forEveryone, at: Date.now() });
      });
    },
    [delAsk, animateOut, commitDelete],
  );
  const undoDelete = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    pendingRef.current = null;
    setPendingDel(null);
    restoreItems(p.items);
    haptic("light");
  }, [restoreItems]);
  /** may I delete this one (for me in 1:1; sender or admin in groups)? */
  const canDelete = useCallback((m: Item) => (isGroup ? m.fromId === me?.id || !!groupRow?.amAdmin : true), [isGroup, me?.id, groupRow?.amAdmin]);
  const toggleSelect = useCallback((m: Item) => {
    setSelected((cur) => {
      if (!cur) return cur;
      const next = new Set(cur);
      if (next.has(keyOf(m))) next.delete(keyOf(m));
      else next.add(keyOf(m));
      return next;
    });
    haptic("light");
  }, []);
  const selectedItems = useMemo(() => (selected && messages ? messages.filter((m) => selected.has(keyOf(m))) : []), [selected, messages]);
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);
  useEffect(() => setSelected(null), [peerId]);
  // ---- emoji reactions / big emoji / interactions ----
  const [overlay, setOverlay] = useState<{ m: Item; target: OverlayTarget } | null>(null);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [arriving, setArriving] = useState<Record<string, string>>({}); // messageId → emoji whose flight is in the air
  const [chipPlay, setChipPlay] = useState<Record<string, string>>({}); // messageId → "emoji|nonce" (replay chip)
  const [interact, setInteract] = useState<Record<string, number>>({}); // messageId → replay nonce (peer tapped it)
  const flightSeq = useRef(0);
  const flyFrom = useRef(new Map<string, DOMRect>());
  const [panelHost, setPanelHost] = useState<HTMLDivElement | null>(null);
  const meRef = useRef(me);
  meRef.current = me;
  useEffect(() => preloadQuickReactions(), []);

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
    const inThreadEv = (ev: DmReactionEvent) =>
      isGroupId(peerId) ? ev.toId === peerId : (ev.fromId === peerId && ev.toId === me?.id) || (ev.fromId === me?.id && ev.toId === peerId);
    const onReactAdd = (ev: DmReactionEvent) => {
      if (!inThreadEv(ev)) return;
      setMessages((list) => (list ? applyReactionEvent(list, ev, true) : list));
      if (isGroupId(peerId) ? ev.userId !== me?.id : ev.userId === peerId) {
        // their reaction lands while I'm looking: chip pops + a burst around it (Telegram plays the effect too)
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const chip = document.querySelector<HTMLElement>(`[data-chip="${CSS.escape(ev.emoji)}"][data-mid="${CSS.escape(ev.messageId)}"]`);
            if (!chip || !inViewport(chip) || !appVisible()) return;
            const r = chip.getBoundingClientRect();
            burst(r.left + 14, r.top + r.height / 2, ev.emoji, false);
            setChipPlay((p) => ({ ...p, [ev.messageId]: `${ev.emoji}|${Date.now()}` }));
          }),
        );
      }
    };
    const onReactRemove = (ev: DmReactionEvent) => inThreadEv(ev) && setMessages((list) => (list ? applyReactionEvent(list, ev, false) : list));
    const onInteract = ({ from, messageId, emoji }: { from: string; messageId: string; emoji: string }) => {
      if (from !== peerId || !appVisible()) return;
      const el = document.querySelector<HTMLElement>(`[data-mid-bubble="${CSS.escape(messageId)}"] [data-big-emoji]`);
      if (!el || !inViewport(el)) return;
      const r = el.getBoundingClientRect();
      setInteract((s) => ({ ...s, [messageId]: (s[messageId] ?? 0) + 1 }));
      burst(r.left + r.width / 2, r.top + r.height / 2, emoji, true);
      haptic("light");
    };
    socket.on("dm:reaction_add", onReactAdd);
    socket.on("dm:reaction_remove", onReactRemove);
    socket.on("dm:emoji_interaction", onInteract);
    socket.on("dm:typing", onTyping);
    socket.on("dm:typing_stop", onTypingStopIn);
    socket.on("dm:read-receipt", onReceipt);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(NATIVE_VISIBILITY_EVENT, onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      socket.off("dm:message", onMsg);
      socket.off("dm:reaction_add", onReactAdd);
      socket.off("dm:reaction_remove", onReactRemove);
      socket.off("dm:emoji_interaction", onInteract);
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
      if (item.media) return; // attachments upload + send through the media outbox (resumable, own retries)
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

  // ---- attachments (photos, videos, files, voice notes): optimistic bubble → resumable upload → send ----
  const mediaCallbacks = useMemo<QueueCallbacks>(
    () => ({
      onDone: (cid, msg) => setMessages((list) => mergeMessages(list ?? [], [{ ...msg, clientId: cid }])),
      onFail: (cid) => setMessages((list) => (list ?? []).map((x) => (x.clientId === cid ? { ...x, state: "failed", autoRetry: false } : x))),
      onCancel: (cid) => setMessages((list) => (list ?? []).filter((x) => x.clientId !== cid)),
    }),
    [],
  );
  const onMediaQueued = useCallback((item: Item) => {
    stickToBottom.current = true;
    smoothNext.current = true;
    setUnseenBelow(0);
    setMessages((list) => [...(list ?? []), item]);
  }, []);
  const mediaCtx = useMemo<MediaSendCtx>(
    () => ({ peerId, peerName: peer ? firstName(peer.name) : undefined, group: isGroupId(peerId), me: me ? { id: me.id, name: me.name, color: me.color } : null, newClientId, onQueued: onMediaQueued, callbacks: mediaCallbacks }),
    [peerId, peer, me, onMediaQueued, mediaCallbacks],
  );
  const canAttach = !!peer && !peer.isBot && (!isGroup || (!!group && !gone)); // groups: members only (photos, files, voice, albums)
  const [pastedFiles, setPastedFiles] = useState<File[] | null>(null);
  const clearPasted = useCallback(() => setPastedFiles(null), []);

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
    const big = bigEmoji(text);
    // emoji-only: it flies from the composer into place, so jump the list (no smooth scroll under the flight)
    smoothNext.current = !big;
    if (big) {
      const box = document.querySelector('[data-testid="composer-input"]')?.getBoundingClientRect();
      if (box) flyFrom.current.set(clientId, box);
    }
    setUnseenBelow(0);
    setMessages((list) => [...(list ?? []), item]);
    armStall(clientId);
    if (connected) void deliver(item);
    return true; // composer clears immediately
  };

  const retry = (m: Item) => {
    if (m.media) {
      if (m.clientId && retryMedia(m.clientId, mediaCallbacks)) setMessages((list) => (list ?? []).map((x) => (x.clientId === m.clientId ? { ...x, state: "sending", autoRetry: undefined } : x)));
      return;
    }
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

  // ---- reactions: optimistic, reconciled with the server's authoritative list in the background ----
  const react = useCallback(
    (msgId: string, emoji: string, from: { x: number; y: number } | null) => {
      const meNow = meRef.current;
      const m = (messagesRef.current ?? []).find((x) => x.id === msgId);
      if (!meNow || !m || m.state) return;
      const prev = m.reactions;
      const removing = prev?.some((r) => r.userId === meNow.id && r.emoji === emoji) ?? false;
      setMessages((list) => (list ? applyReactionEvent(list, { messageId: m.id, userId: meNow.id, emoji, at: serverNow() }, !removing) : list));
      if (!removing) {
        setArriving((a) => ({ ...a, [m.id]: emoji }));
        setFlights((f) => [...f, { id: ++flightSeq.current, emoji, messageId: m.id, from }]);
      } else haptic("light");
      request<{ reactions: DmReaction[] }>(removing ? "dm:reaction_remove" : "dm:reaction_add", { peerId, messageId: m.id, emoji })
        .then((r) => setMessages((list) => (list ? setReactions(list, m.id, r.reactions) : list)))
        .catch((e: Error) => {
          setMessages((list) => (list ? setReactions(list, m.id, prev) : list));
          toast(friendlyMessage(e, "Couldn't add that reaction"));
        });
    },
    [peerId, request, toast],
  );
  const onLand = useCallback((f: Flight) => {
    setFlights((list) => list.filter((x) => x.id !== f.id));
    setArriving((a) => {
      if (a[f.messageId] !== f.emoji) return a;
      const rest = { ...a };
      delete rest[f.messageId];
      return rest;
    });
    setChipPlay((p) => ({ ...p, [f.messageId]: `${f.emoji}|${f.id}` }));
  }, []);
  const onChipToggle = useCallback(
    (m: Item, emoji: string, el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      react(m.id, emoji, { x: r.left + 14, y: r.top + r.height / 2 });
    },
    [react],
  );
  const onQuickReact = useCallback(
    (m: Item, el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      haptic("medium");
      react(m.id, QUICK_REACTION, { x: r.left + r.width / 2, y: r.top });
    },
    [react],
  );
  const onBigTap = useCallback(
    (m: Item, emoji: string, at: { x: number; y: number }) => {
      burst(at.x, at.y, emoji, true);
      haptic("light");
      if (!m.state && !isGroup) socket?.emit("dm:emoji_interaction", { to: peerId, messageId: m.id, emoji });
    },
    [socket, peerId, isGroup],
  );
  const openActions = useCallback((m: Item, el: HTMLElement) => {
    const meNow = meRef.current;
    setOverlay({
      m,
      target: {
        el,
        mine: m.fromId === meNow?.id,
        myReaction: m.reactions?.find((r) => r.userId === meNow?.id)?.emoji ?? null,
        meta: `${formatDaySeparator(m.createdAt)} ${formatClock(m.createdAt)}`,
        // groups too: the server fans group reactions out to every member
        canReact: !m.state,
      },
    });
  }, []);
  const takeFlyFrom = useCallback((clientId: string) => {
    const r = flyFrom.current.get(clientId);
    flyFrom.current.delete(clientId);
    return r;
  }, []);
  const overlayActions = useMemo<MessageAction[]>(() => {
    if (!overlay) return [];
    const m = overlay.m;
    // attachments: Copy copies the caption only (never an auto label like "📷 Photo"); Open → the viewer (save/share/delete)
    const ma = mediaActions(m, me?.id);
    const copy = ma ? ma.copyText : m.text;
    const out: MessageAction[] = copy
      ? [
          {
            key: "copy",
            label: "Copy",
            icon: <Copy className="h-[18px] w-[18px]" />,
            onSelect: () => {
              void copyText(copy).then((ok) => toast(ok ? "Copied" : "Couldn't copy"));
            },
          },
        ]
      : [];
    if (ma && m.media && !m.state && m.media.kind !== "voice" && m.media.kind !== "document" && !mediaGone(m.media, serverNow()) && !m.media.viewOnce)
      out.unshift({ key: "open", label: ma.count > 1 ? "Open album" : "Open", icon: <Maximize2 className="h-[18px] w-[18px]" />, onSelect: () => openViewer({ message: m, from: overlay.target.el.getBoundingClientRect(), mode: "visual", index: 0 }) });
    if (groupRow && !m.state && groupRow.amAdmin) {
      const pinned = groupRow.pinned.has(m.id);
      out.push({ key: "pin", label: pinned ? "Unpin" : "Pin", icon: <Pin className="h-[18px] w-[18px]" />, onSelect: () => groupRow.onPin(m, !pinned) });
    }
    if (m.fromId !== me?.id && !m.state && !peer?.isBot)
      out.push({ key: "report", label: "Report", danger: true, icon: <Flag className="h-[18px] w-[18px]" />, onSelect: () => onReportMessage(m) });
    if (canEdit(m, me?.id))
      out.push({ key: "edit", label: "Edit", icon: <Pencil className="h-[18px] w-[18px]" />, onSelect: () => (setSelected(null), setEditing({ id: m.id, text: m.text })) });
    out.push({ key: "select", label: "Select", icon: <CheckCircle2 className="h-[18px] w-[18px]" />, onSelect: () => setSelected(new Set([keyOf(m)])) });
    if (canDelete(m))
      out.push({ key: "delete", label: "Delete", danger: true, icon: <Trash2 className="h-[18px] w-[18px]" />, onSelect: () => setDelAsk([m]) });
    return out;
  }, [overlay, me?.id, peer?.isBot, toast, onReportMessage, groupRow, canDelete]);

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
    for (const x of messages ?? []) if (x.kind && x.kind !== "call" && x.roomId) set.add(x.roomId);
    for (const ids of linkIds.values()) for (const id of ids) set.add(id);
    return [...set];
  }, [messages, linkIds]);
  const roomCards = useRoomCards(socket, connected, cardIds);
  const latestDropIn = useMemo(() => {
    for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) if (messages![i].kind === "dropin" && messages![i].roomId) return messages![i].roomId!;
    return null;
  }, [messages]);
  // 1:1 calls: header buttons, call-back taps, and the "Call back" deep link from a missed-call push (?call=audio|video)
  const canCall = !!peer && !isGroup && !peer.isBot && !peer.deleted && !iBlocked && !hiddenPeer;
  const callPeer = useCallback(
    (video: boolean) => {
      if (!peer) return;
      void startCall({ id: peer.id, name: peer.name, color: peer.color, photoUrl: peer.photoUrl ?? null, username: peer.username }, video);
    },
    [peer],
  );
  const autoCalled = useRef(false);
  useEffect(() => {
    if (!canCall || autoCalled.current || typeof window === "undefined" || !connected) return;
    const u = new URL(window.location.href);
    const want = u.searchParams.get("call");
    if (want !== "audio" && want !== "video") return;
    autoCalled.current = true;
    u.searchParams.delete("call");
    window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
    callPeer(want === "video");
  }, [canCall, connected, callPeer]);
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
      <header data-app-header className="relative flex h-16 shrink-0 items-center gap-1 border-b border-white/5 px-2">
        {selected && (
          <div className="fade-in absolute inset-0 z-20 flex items-center bg-zinc-950 px-2" data-testid="select-bar">
            <button type="button" onClick={() => setSelected(null)} aria-label="Cancel selection" className="flex h-10 w-10 items-center justify-center rounded-full text-zinc-300 hover:bg-white/5">
              <X className="h-5 w-5" />
            </button>
            <span className="ml-1 min-w-0 flex-1 truncate text-[16px] font-semibold text-zinc-100" data-testid="select-count">
              {selectedItems.length} selected
            </span>
            <button
              type="button"
              disabled={!selectedItems.some((m) => (mediaActions(m, me?.id)?.copyText ?? m.text))}
              onClick={() => {
                const text = selectedItems
                  .map((m) => (parseSticker(m.text) ? "" : mediaActions(m, me?.id)?.copyText ?? m.text))
                  .filter(Boolean)
                  .join("\n\n");
                setSelected(null);
                void copyText(text).then((ok) => toast(ok ? "Copied" : "Couldn't copy"));
              }}
              aria-label="Copy selected"
              data-testid="select-copy"
              className="flex h-10 w-10 items-center justify-center rounded-full text-zinc-200 hover:bg-white/5 disabled:opacity-40"
            >
              <Copy className="h-5 w-5" />
            </button>
            <button
              type="button"
              disabled={!selectedItems.length || !selectedItems.every(canDelete)}
              onClick={() => setDelAsk(selectedItems)}
              aria-label="Delete selected"
              data-testid="select-delete"
              className="flex h-10 w-10 items-center justify-center rounded-full text-red-400 hover:bg-red-500/10 disabled:opacity-40"
            >
              <Trash2 className="h-5 w-5" />
            </button>
          </div>
        )}
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
        {canCall && (
          <>
            <button onClick={() => callPeer(true)} disabled={offline} className="hidden rounded-full p-2 text-zinc-300 hover:bg-white/5 hover:text-zinc-100 disabled:opacity-40 min-[360px]:block" aria-label={`Video call ${peer.name}`} data-testid="dm-video-call">
              <Video className="h-5 w-5" />
            </button>
            <button onClick={() => callPeer(false)} disabled={offline} className="rounded-full p-2 text-zinc-300 hover:bg-white/5 hover:text-zinc-100 disabled:opacity-40" aria-label={`Call ${peer.name}`} data-testid="dm-call">
              <Phone className="h-5 w-5" />
            </button>
          </>
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
      <MediaLayer socket={socket} connected={connected} messages={messages} setMessages={setMessages} me={me} peer={peer} />
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
              {visibleRows.map(({ m, sep, newDay, first, last }, vi) => { const i = vi + rowOffset; return m.kind === "call" && m.call ? (
                <CallMessageRow
                  key={keyOf(m)}
                  meta={m.call}
                  mine={m.fromId === me?.id}
                  time={formatClock(m.createdAt)}
                  sep={sep}
                  sepTitle={formatFull(m.createdAt)}
                  first={first}
                  last={last}
                  peer={peer}
                  disabled={!canCall || offline}
                  onCallBack={callPeer}
                />
              ) : m.kind && m.kind !== "call" && m.roomId ? (
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
                <div key={keyOf(m)}>
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
                  meId={me?.id}
                  onActions={openActions}
                  onChipToggle={onChipToggle}
                  onQuickReact={onQuickReact}
                  onBigTap={onBigTap}
                  arriving={arriving[m.id] ?? null}
                  chipPlay={chipPlay[m.id] ?? null}
                  interactNonce={interact[m.id] ?? 0}
                  takeFlyFrom={takeFlyFrom}
                  selecting={!!selected}
                  selected={!!selected?.has(keyOf(m))}
                  onSelect={toggleSelect}
                  editFlash={flashEdit[m.id] ?? 0}
                />
                {linkIds.has(keyOf(m)) && <RoomLinkCards ids={linkIds.get(keyOf(m))!} cards={roomCards} mine={m.fromId === me?.id} />}
                </div>
              ); })}
              {/* sponsored message in large groups: one per view, after the last message (server-gated, OFF by default) */}
              {isGroup && messages.length > 0 && <SponsoredSlot placement="groups" chat={peerId} className="my-2" />}
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
        {pendingDel && (
          <UndoToast
            key={pendingDel.at}
            startedAt={pendingDel.at}
            label={pendingDel.items.length === 1 ? "Message deleted" : `${pendingDel.items.length} messages deleted`}
            onUndo={undoDelete}
          />
        )}
        {unseenBelow > 0 && !pendingDel && (
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
        {canAttach && <MediaAttach ctx={mediaCtx} disabled={messages === null} pasted={pastedFiles} onPastedConsumed={clearPasted} />}
        <div className="min-w-0 flex-1">
        <ChatComposer
          onSend={send}
          editing={editing}
          onEditSave={saveEdit}
          onEditCancel={() => setEditing(null)}
          idleAction={canAttach ? <MediaVoiceButton ctx={mediaCtx} disabled={messages === null} /> : undefined}
          onPasteFiles={canAttach ? setPastedFiles : undefined}
          onTyping={onTyping}
          onTypingStop={onTypingStop}
          disabled={messages === null}
          placeholder={peer && !isGroup ? `Message ${firstName(peer.name)}…` : "Message…"}
          above={isGroup && group ? (t, set) => <MentionPicker text={t} members={group.members} meId={me?.id} onPick={set} /> : undefined}
          autoFocus
          emojiPanel
          panelHost={panelHost}
        />
        </div>
        </div>
        <div ref={setPanelHost} />
        </>
        )}
      </div>
      {delAsk && (
        <DeleteDialog
          count={delAsk.length}
          group={isGroup}
          peerName={peer ? firstName(peer.name) : undefined}
          canForEveryone={!isGroup && !peer?.deleted && delAsk.every((m) => m.fromId === me?.id && !m.state)}
          onCancel={() => setDelAsk(null)}
          onConfirm={confirmDelete}
        />
      )}
      {overlay && (
        <MessageActionOverlay
          target={overlay.target}
          actions={overlayActions}
          onReact={(emoji, from) => react(overlay.m.id, emoji, from)}
          onClose={() => setOverlay(null)}
        />
      )}
      {flights.map((f) => (
        <ReactionFlight key={f.id} f={f} onLand={onLand} />
      ))}
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
  meId,
  onActions,
  onChipToggle,
  onQuickReact,
  onBigTap,
  arriving,
  chipPlay,
  interactNonce,
  takeFlyFrom,
  selecting,
  selected,
  onSelect,
  editFlash = 0,
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
  meId?: string;
  /** long-press / right-click / hover button → reaction bar + action menu */
  onActions: (m: Item, el: HTMLElement) => void;
  onChipToggle: (m: Item, emoji: string, el: HTMLElement) => void;
  /** double-tap (touch) → quick ❤️ */
  onQuickReact: (m: Item, el: HTMLElement) => void;
  onBigTap: (m: Item, emoji: string, at: { x: number; y: number }) => void;
  arriving: string | null;
  chipPlay: string | null;
  interactNonce: number;
  takeFlyFrom: (clientId: string) => DOMRect | undefined;
  /** multi-select mode: a tap toggles the row, long-press / reactions are off */
  selecting?: boolean;
  selected?: boolean;
  onSelect?: (m: Item) => void;
  /** bumps when this message was edited live (crossfade the new text) */
  editFlash?: number;
}) {
  const sticker = useMemo(() => parseSticker(m.text), [m.text]); // sticker message: large, no bubble
  const parts = useMemo(() => (sticker ? null : bigEmoji(m.text)), [m.text, sticker]);
  void clockTick;
  const bubble = useRef<HTMLDivElement>(null);

  // ---- gestures: long-press (touch/pen) opens the actions; movement beyond the slop = scrolling, cancel ----
  const press = useRef<{ t: ReturnType<typeof setTimeout> | null; x: number; y: number; fired: boolean }>({ t: null, x: 0, y: 0, fired: false });
  const lastTap = useRef(0);
  useEffect(() => () => {
    if (press.current.t) clearTimeout(press.current.t);
  }, []);
  const cancel = () => {
    if (press.current.t) clearTimeout(press.current.t);
    press.current.t = null;
  };
  const open = () => bubble.current && onActions(m, bubble.current);
  const pressHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse" || !e.isPrimary || selecting) return;
      cancel();
      press.current = {
        x: e.clientX,
        y: e.clientY,
        fired: false,
        t: setTimeout(() => {
          press.current.fired = true;
          press.current.t = null;
          open();
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!press.current.t) return;
      if (Math.abs(e.clientX - press.current.x) > PRESS_SLOP_PX || Math.abs(e.clientY - press.current.y) > PRESS_SLOP_PX) cancel();
    },
    onPointerUp: (e: React.PointerEvent) => {
      const wasLong = press.current.fired;
      cancel();
      if (e.pointerType === "mouse" || wasLong || parts || m.state || selecting) return;
      // double-tap → quick reaction (Telegram)
      const now = e.timeStamp;
      if (now - lastTap.current < 300) {
        lastTap.current = 0;
        if (bubble.current) onQuickReact(m, bubble.current);
      } else lastTap.current = now;
    },
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onClickCapture: (e: React.MouseEvent) => {
      // the click that ends a long-press must not also trigger a big-emoji tap / link
      if (press.current.fired) {
        e.stopPropagation();
        e.preventDefault();
        press.current.fired = false;
      }
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      if (selecting) return;
      cancel();
      press.current.fired = false;
      open();
    },
  };

  // emoji-only send: fly from the composer into place with a spring
  useLayoutEffect(() => {
    if (!mine || !parts || !m.clientId || !bubble.current) return;
    const from = takeFlyFrom(m.clientId);
    if (!from) return;
    const to = bubble.current.getBoundingClientRect();
    const size = bigEmojiSize(parts.length) * parts.length;
    const s = Math.max(0.14, Math.min(0.5, 26 / size));
    const fx = from.left + 16 + (size * s) / 2;
    const fy = from.top + from.height / 2;
    const dx = fx - (to.left + to.width / 2);
    const dy = fy - (to.top + to.height / 2);
    animate(bubble.current, [{ transform: `translate3d(${dx}px, ${dy}px, 0) scale(${s})`, opacity: 0.6 }, { transform: "none", opacity: 1 }], {
      spring: { stiffness: 260, damping: 19 },
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // grouped bubble corners: the "tail" side squares off between messages of the same group
  const shape = mine
    ? cn("rounded-[20px]", !first && "rounded-tr-md", !last && "rounded-br-md")
    : cn("rounded-[20px]", !first && "rounded-tl-md", !last && "rounded-bl-md");
  const hasReactions = !!m.reactions?.length;
  return (
    <div
      data-testid="dm-msg"
      data-mine={mine ? "1" : "0"}
      data-mid={m.id}
      data-selected={selecting ? (selected ? "1" : "0") : undefined}
      className={cn("relative", selecting && "cursor-pointer", selected && "rounded-xl bg-emerald-500/[0.08]")}
      onClickCapture={
        selecting
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onSelect?.(m);
            }
          : undefined
      }
    >
      {selecting && (
        <span
          aria-hidden
          className={cn(
            "sel-check pointer-events-none absolute bottom-1 left-0.5 z-[2] flex h-[22px] w-[22px] items-center justify-center rounded-full border-2",
            selected ? "border-emerald-500 bg-emerald-500 text-zinc-950" : "border-zinc-500 bg-zinc-950/60",
          )}
        >
          {selected && (
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.8">
              <path d="M3 8.5l3.2 3L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
      )}
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
      <div className={cn("flex items-end gap-2 transition-transform duration-200 motion-reduce:transition-none", mine ? "justify-end pl-12" : "justify-start pr-12", first ? "mt-2" : "mt-[3px]", hasReactions && "mb-0", selecting && !mine && "translate-x-7")}>
        {!mine && (
          <div className="w-7 shrink-0">
            {last && peer && <Avatar name={peer.name} color={peer.color} photo={peer.photoUrl} size="xs" />}
          </div>
        )}
        {mine && <Receipt m={m} onRetry={onRetry} />}
        {mine && !m.state && !selecting && <ReactButton onClick={open} />}
        {m.media ? (
          <div ref={bubble} title={formatFull(m.createdAt)} data-testid="dm-bubble" data-ts={m.createdAt} data-mid-bubble={m.id} {...pressHandlers} className="msg-in flex min-w-0 max-w-full">
            <MediaBubble m={m} mine={mine} shape={shape} onRetry={onRetry} />
          </div>
        ) : (
        <div
          ref={bubble}
          title={formatFull(m.createdAt)}
          data-testid="dm-bubble"
          data-ts={m.createdAt}
          data-mid-bubble={m.id}
          {...pressHandlers}
          className={cn(
            "min-w-0 text-[15px] leading-[1.35] whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
            !parts && "msg-in",
            sticker
              ? "px-0"
              : parts
              ? "origin-center"
              : cn("px-3.5 py-2", shape, mine ? "bg-emerald-500 text-on-accent" : "dm-theirs bg-zinc-800 text-zinc-100"),
            m.state === "sending" && "opacity-70",
            m.state === "failed" && "opacity-60",
          )}
        >
          {sticker ? (
            <StickerMessage sticker={sticker} pending={m.state === "sending"} />
          ) : parts ? (
            <BigEmoji parts={parts} replay={interactNonce} onTap={(e, at) => onBigTap(m, e, at)} />
          ) : (
            <span key={editFlash} className={editFlash ? "edit-flash" : undefined}>
              {group ? <MentionText text={m.text} meUsername={group.meUsername} mine={mine} /> : m.text}
            </span>
          )}
          {!!m.editedAt && !sticker && (
            <span
              className={cn("ml-1.5 inline-block align-baseline text-[11px] leading-none select-none", mine && !parts ? "opacity-70" : "text-zinc-500", parts && "block text-center")}
              title={`Edited ${formatFull(m.editedAt)}`}
              data-testid="dm-edited"
            >
              edited
            </span>
          )}
        </div>
        )}
        {!mine && !m.state && !selecting && <ReactButton onClick={open} />}
      </div>
      {hasReactions && (
        <ReactionChips
          reactions={m.reactions}
          meId={meId}
          messageId={m.id}
          mine={mine}
          arriving={arriving}
          playKey={chipPlay}
          onToggle={(emoji, el) => onChipToggle(m, emoji, el)}
        />
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

/** Desktop: a small "react" button beside the bubble on hover (touch uses long-press / double-tap instead). */
function ReactButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="React or more actions"
      className="msg-react-btn mb-1 hidden h-7 w-7 shrink-0 items-center justify-center self-center rounded-full text-zinc-500 hover:bg-white/5 hover:text-zinc-200 [@media(hover:hover)_and_(pointer:fine)]:flex"
      data-testid="dm-react-btn"
    >
      <Smile className="h-[18px] w-[18px]" />
    </button>
  );
}

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
