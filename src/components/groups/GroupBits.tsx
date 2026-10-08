"use client";

/**
 * Group chat building blocks shared by the thread (DmThread in group mode), the inbox and the group screens.
 * Everything here is additive: 1:1 conversations never render these.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BellOff, Pin, X } from "lucide-react";
import type { DirectMessage, PublicUser } from "@/lib/types";
import { isGroupId, serviceText, type ConvMessage, type GroupInfo, type GroupMember, type GroupPin, type GroupSummary, type InboxItem } from "@/lib/groups";
import { cn, firstName } from "@/lib/utils";
import { formatListTime } from "@/lib/time";
import { useApp } from "../AppProvider";
import { Avatar } from "../Avatar";
import { TypingLabel } from "../chat/TypingDots";
import { Sheet } from "../Sheet";
import { SwipeRow } from "../chat/ChatActions";
import { friendlyMessage } from "@/lib/errors";

/** A sender as the PublicUser-shaped "peer" DM bubbles expect (avatar next to their messages). */
export function senderPeer(m: DirectMessage, members?: Map<string, GroupMember>): PublicUser {
  const mem = members?.get(m.fromId);
  return {
    id: m.fromId,
    name: mem?.name ?? m.fromName,
    username: mem?.username ?? "",
    color: mem?.color ?? m.fromColor,
    photoUrl: mem?.photoUrl ?? m.fromPhotoUrl ?? null,
    interests: [],
    bio: "",
    isBot: false,
    createdAt: 0,
    followers: 0,
    following: 0,
  };
}

/** Centered grey pill: "Maya added Ryan", "You pinned “…”". Names resolve live from the member list. */
export const ServiceRow = memo(function ServiceRow({ m, meId, members }: { m: ConvMessage; meId?: string; members?: Map<string, GroupMember> }) {
  let text = m.text;
  if (m.service) {
    const ids = [m.service.actorId, ...(m.service.targetIds ?? [])];
    // only re-render locally ("You added…") when we know every name; otherwise keep the server's text
    if (ids.every((id) => id === meId || members?.has(id))) text = serviceText(m.service, (id) => members?.get(id)?.name ?? "Someone", meId);
  }
  return (
    <div className="my-2 flex justify-center px-6" data-testid="group-service" data-mid={m.id}>
      <span className="max-w-full rounded-full bg-white/[0.06] px-3 py-1 text-center text-[12px] leading-snug font-medium text-zinc-400 [overflow-wrap:anywhere]">{text}</span>
    </div>
  );
});

const MENTION_SPLIT = /((?:^|[^\w@])@[A-Za-z0-9_]{3,20}(?![A-Za-z0-9_]))/g;

/** Message text with @handles highlighted; mentions of me get the stronger highlight. */
export function MentionText({ text, meUsername, mine }: { text: string; meUsername?: string; mine?: boolean }) {
  if (!text.includes("@")) return <>{text}</>;
  const parts = text.split(MENTION_SPLIT);
  const me = meUsername?.toLowerCase();
  return (
    <>
      {parts.map((p, i) => {
        const at = p.indexOf("@");
        if (i % 2 === 0 || at < 0) return p;
        const lead = p.slice(0, at);
        const handle = p.slice(at + 1);
        const isMe = !!me && handle.toLowerCase() === me;
        return (
          <span key={i}>
            {lead}
            <span
              data-testid="mention"
              data-me={isMe ? "1" : undefined}
              className={cn("font-semibold", mine ? "underline decoration-white/40 underline-offset-2" : isMe ? "rounded bg-amber-400/20 px-0.5 text-amber-300" : "text-sky-400")}
            >
              @{handle}
            </span>
          </span>
        );
      })}
    </>
  );
}

/** True when `text` mentions `username` (case-insensitive). */
export function mentionsMe(text: string, username?: string) {
  if (!username || !text.includes("@")) return false;
  const re = new RegExp(`(^|[^\\w@])@${username.replace(/[^A-Za-z0-9_]/g, "")}(?![A-Za-z0-9_])`, "i");
  return re.test(text);
}

/**
 * Telegram-style pinned bar under the header: newest pin first, tap → jump to that message and cycle to the
 * next older pin. Admins get an unpin (×). Fixed 44px height so the list never jumps.
 */
export function PinnedBar({ pins, canUnpin, onJump, onUnpin }: { pins: GroupPin[]; canUnpin: boolean; onJump: (messageId: string) => void; onUnpin: (messageId: string) => void }) {
  const ordered = useMemo(() => [...pins].sort((a, b) => b.pinnedAt - a.pinnedAt), [pins]);
  const [idx, setIdx] = useState(0);
  useEffect(() => setIdx(0), [ordered.length]);
  if (!ordered.length) return null;
  const cur = ordered[Math.min(idx, ordered.length - 1)];
  const text = cur.message ? (cur.message.text.startsWith("[sticker:") ? "Sticker" : cur.message.text) : "Message unavailable";
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/5 bg-zinc-950/60 pr-1 pl-3" data-testid="group-pinned-bar">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        onClick={() => {
          onJump(cur.messageId);
          if (ordered.length > 1) setIdx((i) => (i + 1) % ordered.length);
        }}
        aria-label="Jump to pinned message"
      >
        <span className="flex h-7 w-[3px] shrink-0 flex-col gap-[2px]" aria-hidden>
          {ordered.slice(0, 4).map((p, i) => (
            <span key={p.messageId} className={cn("w-full flex-1 rounded-full", i === Math.min(idx, 3) ? "bg-emerald-400" : "bg-emerald-400/30")} />
          ))}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] leading-tight font-semibold text-emerald-400">
            Pinned message{ordered.length > 1 ? ` #${ordered.length - Math.min(idx, ordered.length - 1)}` : ""}
          </span>
          <span className="block truncate text-[13px] leading-tight text-zinc-300">{text}</span>
        </span>
      </button>
      {canUnpin ? (
        <button type="button" onClick={() => onUnpin(cur.messageId)} className="rounded-full p-2 text-zinc-500 hover:bg-white/5 hover:text-zinc-200" aria-label="Unpin">
          <X className="h-4 w-4" />
        </button>
      ) : (
        <Pin className="mr-2 h-4 w-4 shrink-0 text-zinc-600" aria-hidden />
      )}
    </div>
  );
}

/** Scroll a message into view inside its list and flash it (tap on a pin / reply). */
export function jumpToMessage(list: HTMLElement | null, messageId: string) {
  const safe = messageId.replace(/[^A-Za-z0-9_-]/g, "");
  const el = list?.querySelector<HTMLElement>(`[data-mid="${safe}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  // brief highlight (Web Animations: iOS 13.1+ / every evergreen engine; skipped for reduced motion)
  const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduce && typeof el.animate === "function")
    el.animate([{ backgroundColor: "rgba(16,185,129,0.22)" }, { backgroundColor: "rgba(16,185,129,0)" }], { duration: 1400, easing: "ease-out" });
  return true;
}

/** @-mention suggestions above the composer while the word at the end of the text starts with "@". */
export function MentionPicker({ text, members, meId, onPick }: { text: string; members: GroupMember[]; meId?: string; onPick: (next: string) => void }) {
  const m = /(^|\s)@([A-Za-z0-9_]{0,20})$/.exec(text);
  if (!m) return null;
  const q = m[2].toLowerCase();
  const list = members
    .filter((x) => x.id !== meId && x.username && (x.username.toLowerCase().startsWith(q) || x.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))))
    .slice(0, 6);
  if (!list.length) return null;
  return (
    <ul className="mb-2 max-h-48 overflow-y-auto overscroll-contain rounded-2xl border border-white/10 bg-zinc-900 p-1 shadow-xl" role="listbox" data-testid="mention-picker">
      {list.map((x) => (
        <li key={x.id}>
          <button
            type="button"
            role="option"
            aria-selected={false}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onPick(text.slice(0, text.length - m[2].length) + x.username + " ")}
            className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left hover:bg-white/5"
          >
            <Avatar name={x.name} color={x.color} photo={x.photoUrl} size="xs" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{x.name}</span>
            <span className="shrink-0 truncate text-xs text-zinc-500">@{x.username}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** "12 members, 3 online" */
export function memberLine(g: Pick<GroupInfo, "memberCount" | "members"> | null, presenceOf: (id: string) => string) {
  if (!g) return "";
  const online = g.members.filter((m) => presenceOf(m.id) === "online").length;
  const n = g.memberCount;
  return `${n} member${n === 1 ? "" : "s"}${online > 1 ? `, ${online} online` : ""}`;
}

// ---------------------------------------------------------------------------------------------------------
// Inbox: group rows next to 1:1 conversations

export type GroupRowItem = Extract<InboxItem, { type: "group" }>;

/**
 * Group conversations for the inbox (conv:list), kept live from pushed events: new messages move the row up,
 * group:update renames, group:removed drops it, conv:typing shows "Maya is typing…".
 */
export function useGroupInbox() {
  const { socket, connected, request, me } = useApp();
  const [rows, setRows] = useState<GroupRowItem[] | null>(null);
  const [typing, setTyping] = useState<Record<string, string>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const meId = me?.id;
  const meUsername = me?.username;

  const load = useCallback(() => {
    request<{ items: InboxItem[] }>("conv:list")
      .then((r) => setRows(r.items.filter((x): x is GroupRowItem => x.type === "group")))
      .catch(() => setRows((x) => x ?? []));
  }, [request]);

  useEffect(() => {
    if (connected) load();
    else setTyping({});
  }, [connected, load]);

  useEffect(() => {
    if (!socket || !meId) return;
    const clearTyping = (gid: string) => {
      clearTimeout(timers.current.get(gid));
      setTyping((t) => {
        if (!(gid in t)) return t;
        const n = { ...t };
        delete n[gid];
        return n;
      });
    };
    const onMsg = (m: ConvMessage) => {
      if (!isGroupId(m.toId)) return;
      clearTyping(m.toId);
      setRows((list) => {
        if (!list) return list;
        const i = list.findIndex((r) => r.id === m.toId);
        if (i < 0) {
          load(); // added to a new group
          return list;
        }
        const r = list[i];
        if (r.lastMessage && (r.lastMessage.id === m.id || r.lastMessage.createdAt > m.createdAt)) return list;
        const mine = m.fromId === meId;
        const next: GroupRowItem = {
          ...r,
          lastMessage: m,
          updatedAt: m.createdAt,
          unread: mine ? 0 : r.unread + 1,
          mentioned: mine ? false : r.mentioned || (!m.service && mentionsMe(m.text, meUsername)),
        };
        return [next, ...list.slice(0, i), ...list.slice(i + 1)];
      });
    };
    const onUpdate = ({ group }: { group: GroupInfo }) =>
      setRows((list) => list?.map((r) => (r.id === group.id ? { ...r, group: toSummary(group), muted: group.muted } : r)) ?? list);
    const onRemoved = ({ id }: { id: string }) => setRows((list) => list?.filter((r) => r.id !== id) ?? list);
    const onTyping = ({ conversationId, name }: { conversationId: string; name?: string }) => {
      if (!isGroupId(conversationId)) return;
      setTyping((t) => ({ ...t, [conversationId]: firstName(name ?? "Someone") }));
      clearTimeout(timers.current.get(conversationId));
      timers.current.set(conversationId, setTimeout(() => clearTyping(conversationId), 6000));
    };
    const onTypingStop = ({ conversationId }: { conversationId: string }) => clearTyping(conversationId);
    // reading a group on another device / in the thread clears the badge
    const onRead = ({ conversationId }: { conversationId: string }) =>
      setRows((list) => list?.map((x) => (x.id === conversationId ? { ...x, unread: 0, mentioned: false } : x)) ?? list);
    const onDeleted = ({ conversationId, messageId }: { conversationId: string; messageId: string }) => {
      setRows((list) => {
        const r = list?.find((x) => x.id === conversationId);
        if (r?.lastMessage?.id === messageId) load();
        return list;
      });
    };
    // inbox pin / unpin from this or another of my devices (dm:chat with a group id)
    const onChatState = (st: { peerId: string; pinned: boolean }) =>
      isGroupId(st.peerId) &&
      setRows((list) => list?.map((x) => (x.id !== st.peerId || !!x.pinnedAt === st.pinned ? x : { ...x, pinnedAt: st.pinned ? Date.now() : undefined })) ?? list);
    socket.on("dm:chat-state", onChatState);
    socket.on("dm:message", onMsg);
    socket.on("group:update", onUpdate);
    socket.on("group:removed", onRemoved);
    socket.on("conv:typing", onTyping);
    socket.on("conv:typing_stop", onTypingStop);
    socket.on("conv:read", onRead);
    socket.on("conv:deleted", onDeleted);
    const t = timers.current;
    return () => {
      socket.off("dm:chat-state", onChatState);
      socket.off("dm:message", onMsg);
      socket.off("group:update", onUpdate);
      socket.off("group:removed", onRemoved);
      socket.off("conv:typing", onTyping);
      socket.off("conv:typing_stop", onTypingStop);
      socket.off("conv:read", onRead);
      socket.off("conv:deleted", onDeleted);
      for (const x of t.values()) clearTimeout(x);
    };
  }, [socket, meId, meUsername, load]);

  /** opening a group from the inbox: clear its badge optimistically (the thread sends the real dm:read) */
  const markOpened = useCallback((gid: string) => setRows((list) => list?.map((x) => (x.id === gid ? { ...x, unread: 0, mentioned: false } : x)) ?? list), []);
  return { rows, typing, markOpened };
}

export function toSummary(g: GroupInfo | GroupSummary): GroupSummary {
  return { id: g.id, title: g.title, description: g.description, color: g.color, photoUrl: g.photoUrl, memberCount: g.memberCount, createdAt: g.createdAt };
}

/** One group row in the inbox: avatar, title, "Maya: hey" preview, time, unread / @ badges, mute icon. */
export const GroupInboxRow = memo(function GroupInboxRow({
  r,
  meId,
  typingName,
  onOpen,
  onMenu,
  onLeave,
}: {
  r: GroupRowItem;
  meId?: string;
  typingName?: string;
  onOpen?: (gid: string) => void;
  /** long-press / right-click (the shared inbox ChatRowMenu) */
  onMenu?: (gid: string) => void;
  /** swipe left → "Leave" */
  onLeave?: (gid: string) => void;
}) {
  const lm = r.lastMessage;
  const mine = lm?.fromId === meId;
  // my own service events read "You pinned …" (the stored text uses my name)
  const preview = !lm
    ? "No messages yet"
    : lm.service && lm.service.actorId === meId && lm.text.startsWith(lm.fromName)
      ? `You${lm.text.slice(lm.fromName.length)}`
      : lm.text.startsWith("[sticker:")
        ? "Sticker"
        : lm.text;
  const link = (
      <Link
        href={`/messages/${r.id}`}
        onClick={() => onOpen?.(r.id)}
        data-testid="group-row"
        data-group={r.id}
        className="flex items-center gap-3 rounded-2xl px-3 py-2.5 transition-colors hover:bg-white/5 active:bg-white/[0.07]"
      >
        <Avatar name={r.group.title} color={r.group.color} photo={r.group.photoUrl} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className={cn("flex min-w-0 items-center gap-1 text-[15px]", r.unread ? "font-bold text-zinc-50" : "font-semibold text-zinc-100")}>
              <span className="truncate">{r.group.title}</span>
              {r.muted && <BellOff className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-label="Muted" />}
            </span>
            <span className={cn("shrink-0 text-xs", r.unread && !r.muted ? "font-semibold text-sky-400" : "text-zinc-500")}>{formatListTime(lm?.createdAt ?? r.updatedAt)}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-2">
            <p className={cn("min-w-0 flex-1 truncate text-sm", r.unread ? "font-medium text-zinc-200" : "text-zinc-500")}>
              {typingName ? (
                <span className="inline-flex items-center gap-1">
                  <span className="text-zinc-300">{typingName}</span> <TypingLabel testId="group-row-typing" />
                </span>
              ) : lm && !lm.service ? (
                <>
                  <span className={r.unread ? "text-zinc-300" : "text-zinc-400"}>{mine ? "You" : firstName(lm.fromName)}: </span>
                  {preview}
                </>
              ) : (
                preview
              )}
            </p>
            {r.mentioned && r.unread > 0 && (
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-500 text-[12px] font-bold text-on-color" aria-label="You were mentioned" data-testid="group-row-mention">
                @
              </span>
            )}
            {r.unread > 0 && (
              <span
                className={cn("flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-bold", r.muted ? "bg-zinc-600 text-zinc-100" : "bg-sky-500 text-on-color")}
                data-testid="group-row-unread"
              >
                {r.unread > 99 ? "99+" : r.unread}
              </span>
            )}
            {!!r.pinnedAt && !r.unread && <Pin className="h-3.5 w-3.5 shrink-0 rotate-45 text-zinc-500" aria-label="Pinned" data-testid="group-row-pinned" />}
          </div>
        </div>
      </Link>
  );
  return (
    <li className="cv-auto [contain-intrinsic-size:auto_72px]">
      {onMenu ? (
        <SwipeRow onMenu={() => onMenu(r.id)} onRemove={() => onLeave?.(r.id)} removeText="Leave" testId="group-row-swipe">
          {link}
        </SwipeRow>
      ) : (
        link
      )}
    </li>
  );
});

/** Live GroupInfo for one group (group:get + group:update / group:pins / group:removed). `autoload=false` when the
 * caller already gets it elsewhere (the thread's dm:history response carries it). */
export function useGroupInfo(gid: string | null, autoload = true) {
  const { socket, connected, request } = useApp();
  const [group, setGroup] = useState<GroupInfo | null>(null);
  const [gone, setGone] = useState<null | "removed" | "left" | "missing">(null);
  useEffect(() => {
    setGroup(null);
    setGone(null);
  }, [gid]);
  const reload = useCallback(() => {
    if (!gid) return;
    request<{ group: GroupInfo }>("group:get", { id: gid })
      .then((r) => {
        setGroup(r.group);
        setGone(null);
      })
      .catch(() => setGone((g) => g ?? "missing"));
  }, [gid, request]);
  useEffect(() => {
    if (gid && connected && autoload) reload();
  }, [gid, connected, autoload, reload]);
  useEffect(() => {
    if (!socket || !gid) return;
    const onUpdate = ({ group: g }: { group: GroupInfo }) => g?.id === gid && (setGroup(g), setGone(null));
    const onPins = ({ id, pins }: { id: string; pins: GroupPin[] }) => id === gid && setGroup((g) => (g ? { ...g, pins } : g));
    const onRemoved = ({ id, reason }: { id: string; reason: "removed" | "left" }) => id === gid && setGone(reason);
    socket.on("group:update", onUpdate);
    socket.on("group:pins", onPins);
    socket.on("group:removed", onRemoved);
    return () => {
      socket.off("group:update", onUpdate);
      socket.off("group:pins", onPins);
      socket.off("group:removed", onRemoved);
    };
  }, [socket, gid]);
  return { group, setGroup, gone, setGone, reload };
}

/** 1:1 conversations (dm:list) + group rows, newest activity first. */
export function mergeInbox<C extends { lastMessage: { createdAt: number } }>(dms: C[], groups: GroupRowItem[] | null): (C | GroupRowItem)[] {
  if (!groups?.length) return dms;
  const at = (x: C | GroupRowItem) => ("group" in x ? (x as GroupRowItem).lastMessage?.createdAt ?? (x as GroupRowItem).updatedAt : (x as C).lastMessage.createdAt);
  return [...dms, ...groups].sort((a, b) => at(b) - at(a));
}

/** who becomes owner when the owner leaves (server: oldest admin, else oldest member) */
export function successorName(members: GroupMember[], meId?: string) {
  const others = members.filter((m) => m.id !== meId);
  if (!others.length) return null;
  const admins = others.filter((m) => m.role === "admin").sort((a, b) => a.joinedAt - b.joinedAt);
  return (admins[0] ?? [...others].sort((a, b) => a.joinedAt - b.joinedAt)[0]).name;
}

export function LeaveSheet({ open, onClose, isOwner, successor, onLeave }: { open: boolean; onClose: () => void; isOwner: boolean; successor: string | null; onLeave: () => void }) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Leave group?"
      footer={
        <div className="flex gap-2">
          <button onClick={onClose} className="h-11 flex-1 rounded-full border border-white/15 text-sm font-semibold text-zinc-200 hover:bg-white/5">
            Cancel
          </button>
          <button onClick={onLeave} className="h-11 flex-1 rounded-full bg-red-500 text-sm font-semibold text-white hover:bg-red-400" data-testid="group-leave-confirm">
            Leave
          </button>
        </div>
      }
    >
      <p className="text-sm text-zinc-400">
        {isOwner && successor
          ? `You're the owner. ${successor} will become the owner when you leave (or transfer ownership to someone else first from the member list).`
          : isOwner
            ? "You're the last member — the group will be closed."
            : "You won't get messages from this group anymore. An admin or an invite link can add you back."}
      </p>
    </Sheet>
  );
}

/** Leave from the inbox (swipe / long-press): loads the group to show the right owner/successor copy. */
export function InboxLeaveGroup({ gid, onClose }: { gid: string | null; onClose: () => void }) {
  const { request, toast, me } = useApp();
  const { group } = useGroupInfo(gid);
  const isOwner = group?.myRole === "owner";
  return (
    <LeaveSheet
      open={!!gid}
      onClose={onClose}
      isOwner={isOwner}
      successor={isOwner && group ? successorName(group.members, me?.id) : null}
      onLeave={() => {
        if (!gid) return;
        onClose();
        request("group:leave", { id: gid }).catch((e: unknown) => toast(friendlyMessage(e, "Couldn't leave the group")));
      }}
    />
  );
}
