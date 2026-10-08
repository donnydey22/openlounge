"use client";

import { displayUser, useDeletedIds } from "@/lib/userDisplay";
import { TypingLabel } from "@/components/chat/TypingDots";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, PenSquare, Phone, Pin, Search, Users } from "lucide-react";
import type { ChatStateEvent, ConversationSummary, DirectMessage, PublicUser } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatListTime, useClockTick } from "@/lib/time";
import { useApp } from "@/components/AppProvider";
import { TopBar } from "@/components/TopBar";
import { Avatar } from "@/components/Avatar";
import { Sheet } from "@/components/Sheet";
import { ChatRowMenu, RemoveChatConfirm, SwipeRow, removeLabel, sortPinned } from "@/components/chat/ChatActions";
import { GroupInboxRow, InboxLeaveGroup, mergeInbox, useGroupInbox } from "@/components/groups/GroupBits";

export default function MessagesPage() {
  useDeletedIds(); // re-render when someone deletes their account (live ghost)
  const { socket, connected, request, me, setActiveDm, presenceOf } = useApp();
  useClockTick(); // inbox stamps flip ("9:24 PM" → "Yesterday") on the minute tick / foreground / timezone change
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [composing, setComposing] = useState(false);
  const [typing, setTyping] = useState<Set<string>>(new Set());
  const typingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const meId = me?.id;
  const groupInbox = useGroupInbox(); // group rows (conv:list), merged by recency below

  // one-shot fetch on open and after a reconnect; everything else is applied from pushed events
  const load = useCallback(() => {
    request<{ conversations: ConversationSummary[] }>("dm:list")
      .then((r) => setConversations(r.conversations))
      .catch(() => setConversations((c) => c ?? []));
  }, [request]);

  useEffect(() => {
    if (connected) load();
    else setTyping(new Set());
  }, [connected, load]);

  useEffect(() => {
    setActiveDm("*");
    return () => setActiveDm(null);
  }, [setActiveDm]);

  // inbox actions (long-press / right-click / swipe): pin, mark read, remove ("Delete chat for me")
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PublicUser | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null); // group rows: swipe / menu → leave
  const dropRow = useCallback((peerId: string) => setConversations((list) => list && list.filter((c) => c.peer.id !== peerId)), []);
  useEffect(() => {
    if (!socket) return;
    // my other devices (or this one) changed a chat's inbox state
    const onState = (st: ChatStateEvent) =>
      setConversations((list) => {
        if (!list) return list;
        if (st.hidden) return list.filter((c) => c.peer.id !== st.peerId);
        return list.map((c) => (c.peer.id !== st.peerId || !!c.pinnedAt === st.pinned ? c : { ...c, pinnedAt: st.pinned ? Date.now() : undefined }));
      });
    socket.on("dm:chat-state", onState);
    return () => {
      socket.off("dm:chat-state", onState);
    };
  }, [socket]);

  // live: a DM to/from me moves that conversation to the top in place (no refetch, no flash)
  useEffect(() => {
    if (!socket || !meId) return;
    const onMsg = (m: DirectMessage) => {
      if (m.toId.startsWith("g_")) return; // group messages: useGroupInbox
      if (m.fromId !== meId && m.toId !== meId) return;
      const peerId = m.fromId === meId ? m.toId : m.fromId;
      setTyping((t) => (t.has(peerId) ? new Set([...t].filter((x) => x !== peerId)) : t));
      setConversations((list) => {
        if (!list) return list;
        const i = list.findIndex((c) => c.peer.id === peerId);
        if (i < 0) {
          load(); // brand-new conversation: need the peer's profile
          return list;
        }
        const c = list[i];
        if (c.lastMessage.id === m.id || c.lastMessage.createdAt > m.createdAt) return list;
        const updated = { ...c, lastMessage: m, unread: m.fromId === meId ? 0 : c.unread + 1 };
        return [updated, ...list.slice(0, i), ...list.slice(i + 1)];
      });
    };
    const onTyping = ({ from }: { from: string }) => {
      setTyping((t) => (t.has(from) ? t : new Set(t).add(from)));
      const timers = typingTimers.current;
      clearTimeout(timers.get(from));
      timers.set(
        from,
        setTimeout(() => setTyping((t) => new Set([...t].filter((x) => x !== from))), 6000),
      );
    };
    const clearTyping = (from: string) => {
      clearTimeout(typingTimers.current.get(from));
      setTyping((t) => (t.has(from) ? new Set([...t].filter((x) => x !== from)) : t));
    };
    const onTypingStop = ({ from }: { from: string }) => clearTyping(from);
    const onMsgTyping = (m: { fromId: string }) => clearTyping(m.fromId);
    socket.on("dm:message", onMsg);
    socket.on("dm:typing", onTyping);
    socket.on("dm:typing_stop", onTypingStop);
    socket.on("dm:message", onMsgTyping);
    const timers = typingTimers.current;
    return () => {
      socket.off("dm:message", onMsg);
      socket.off("dm:typing", onTyping);
      socket.off("dm:typing_stop", onTypingStop);
      socket.off("dm:message", onMsgTyping);
      for (const t of timers.values()) clearTimeout(t);
    };
  }, [socket, meId, load]);

  // keep "5m" labels fresh without refetching
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-2 pt-5 pb-24">
        <div className="mb-3 flex items-center justify-between px-2">
          <h1 className="text-2xl font-bold tracking-tight">Messages</h1>
          <div className="flex items-center gap-1.5">
            <Link href="/calls" aria-label="Calls" data-testid="open-calls" className="grid h-10 w-10 place-items-center rounded-full text-zinc-300 hover:bg-white/5 hover:text-white">
              <Phone className="h-5 w-5" />
            </Link>
            <button
              onClick={() => setComposing(true)}
              className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-on-accent hover:bg-emerald-400"
            >
              <PenSquare className="h-4 w-4" /> New
            </button>
          </div>
        </div>

        {conversations === null ? (
          <ul className="space-y-1" aria-hidden>
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-3 p-3">
                <div className="openlounge-hex h-14 w-14 animate-pulse bg-zinc-800" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-32 animate-pulse rounded-full bg-zinc-800" />
                  <div className="h-3 w-48 animate-pulse rounded-full bg-zinc-800/70" />
                </div>
              </li>
            ))}
          </ul>
        ) : conversations.length === 0 && !groupInbox.rows?.length ? (
          <div className="mx-2 rounded-3xl border border-dashed border-white/10 p-10 text-center text-zinc-500">
            <div className="mb-2 text-3xl">✉️</div>
            No conversations yet.
            <br />
            Tap <b className="text-zinc-300">New</b>, or hit <b className="text-zinc-300">Message</b> on anyone&apos;s profile.
          </div>
        ) : (
          <ul data-testid="dm-conversations">
            {sortPinned(mergeInbox(conversations, groupInbox.rows)).map((c0) => {
              if ("group" in c0) return <GroupInboxRow key={c0.id} r={c0} meId={me?.id} typingName={groupInbox.typing[c0.id]} onOpen={groupInbox.markOpened} onMenu={setMenuFor} onLeave={setLeaving} />;
              const peer = displayUser(c0.peer);
              // deleted accounts never show unread (the server clears them too)
              const c = { ...c0, peer, unread: peer.deleted ? 0 : c0.unread };
              const mine = c.lastMessage.fromId === me?.id;
              const st = c.peer.isBot ? "offline" : presenceOf(c.peer.id);
              const isTyping = typing.has(c.peer.id);
              return (
                <li key={c.peer.id} className="cv-auto [contain-intrinsic-size:auto_72px]">
                  <SwipeRow onMenu={() => setMenuFor(c.peer.id)} onRemove={() => setRemoving(c.peer)} removeText={removeLabel(!!c.peer.deleted)}>
                  <Link
                    href={`/messages/${c.peer.id}`}
                    data-testid="dm-row"
                    data-peer={c.peer.id}
                    data-presence={st}
                    className="flex items-center gap-3 rounded-2xl px-3 py-2.5 transition-colors hover:bg-white/5 active:bg-white/[0.07]"
                  >
                    <Avatar name={c.peer.name} color={c.peer.color} photo={c.peer.photoUrl} size="md" presence={st === "offline" ? null : st} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={cn("truncate text-[15px]", c.unread ? "font-bold text-zinc-50" : "font-semibold text-zinc-100")}>{c.peer.name}</span>
                        <span className={cn("shrink-0 text-xs", c.unread ? "font-semibold text-sky-400" : "text-zinc-500")}>{formatListTime(c.lastMessage.createdAt)}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <p className={cn("min-w-0 flex-1 truncate text-sm", c.unread ? "font-medium text-zinc-200" : "text-zinc-500")}>
                          {isTyping ? (
                            <TypingLabel testId="dm-row-typing" />
                          ) : (
                            <>
                              {mine && <span className="text-zinc-500">You: </span>}
                              {c.lastMessage.text}
                            </>
                          )}
                        </p>
                        {c.unread > 0 && (
                          <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-sky-500 px-1.5 text-[11px] font-bold text-on-color">
                            {c.unread > 99 ? "99+" : c.unread}
                          </span>
                        )}
                        {!!c.pinnedAt && !c.unread && <Pin className="h-3.5 w-3.5 shrink-0 rotate-45 text-zinc-500" aria-label="Pinned" data-testid="dm-row-pinned" />}
                      </div>
                    </div>
                  </Link>
                  </SwipeRow>
                </li>
              );
            })}
          </ul>
        )}
      </main>
      <NewMessageSheet open={composing} onClose={() => setComposing(false)} />
      {(() => {
        const g = menuFor ? groupInbox.rows?.find((x) => x.id === menuFor) : undefined;
        if (g)
          return (
            <ChatRowMenu
              chat={{ peer: { id: g.id, name: g.group.title }, pinned: !!g.pinnedAt, unread: g.unread }}
              removeText="Leave group"
              onClose={() => setMenuFor(null)}
              onRemove={() => setLeaving(g.id)}
              onChanged={() => {}}
            />
          );
        const c = menuFor ? conversations?.find((x) => x.peer.id === menuFor) : undefined;
        const peer = c ? displayUser(c.peer) : null;
        return (
          <ChatRowMenu
            chat={c && peer ? { peer, pinned: !!c.pinnedAt, unread: peer.deleted ? 0 : c.unread } : null}
            onClose={() => setMenuFor(null)}
            onRemove={() => peer && setRemoving(peer)}
            onChanged={() => load()}
          />
        );
      })()}
      <RemoveChatConfirm peer={removing} onClose={() => setRemoving(null)} onRemoved={dropRow} />
      <InboxLeaveGroup gid={leaving} onClose={() => setLeaving(null)} />
    </>
  );
}

function NewMessageSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { request, me, following, presenceOf } = useApp();
  const router = useRouter();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) return;
    setQ("");
    request<{ users: PublicUser[] }>("users:list")
      .then((r) => setUsers(r.users))
      .catch(() => {});
  }, [open, request]);

  const needle = q.trim().toLowerCase();
  const list = useMemo(
    () =>
      users
        .filter((u) => u.id !== me?.id && (!needle || u.name.toLowerCase().includes(needle)))
        // people you follow first, then real people, then demo users
        .sort((a, b) => Number(following.has(b.id)) - Number(following.has(a.id)) || Number(a.isBot) - Number(b.isBot)),
    [users, needle, me?.id, following],
  );

  return (
    <Sheet open={open} onClose={onClose} title="New message">
      <button
        type="button"
        onClick={() => {
          onClose();
          router.push("/groups/new");
        }}
        className="mb-2 flex w-full items-center gap-3 rounded-2xl p-2.5 text-left hover:bg-white/5"
        data-testid="new-group"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400">
          <Users className="h-5 w-5" />
        </span>
        <span className="font-semibold">New group</span>
      </button>
      <div className="relative mb-3">
        <Search className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search people"
          className="w-full rounded-full border border-white/10 bg-zinc-950 py-2.5 pr-4 pl-11 outline-none placeholder:text-zinc-600 focus:border-emerald-500/60"
        />
      </div>
      <ul className="max-h-[50vh] space-y-0.5 overflow-y-auto">
        {list.map((u) => (
          <li key={u.id}>
            <button
              onClick={() => {
                onClose();
                router.push(`/messages/${u.id}`);
              }}
              className="flex w-full items-center gap-3 rounded-2xl p-2.5 text-left hover:bg-white/5"
            >
              <Avatar name={u.name} color={u.color} photo={u.photoUrl} size="sm" presence={u.isBot || presenceOf(u.id) === "offline" ? null : (presenceOf(u.id) as "online" | "away")} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{u.name}</div>
                <div className="truncate text-xs text-zinc-500">
                  {following.has(u.id) ? "Following · " : ""}
                  {u.isBot ? "Demo user" : u.bio || "Member"}
                </div>
              </div>
            </button>
          </li>
        ))}
        {list.length === 0 && (
          <li className="py-6 text-center text-sm text-zinc-500">{needle ? `No people match “${q}”.` : "No one else is here yet."}</li>
        )}
      </ul>
    </Sheet>
  );
}
