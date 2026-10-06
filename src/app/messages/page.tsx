"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, PenSquare, Search } from "lucide-react";
import type { ConversationSummary, DirectMessage, PublicUser } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
import { useApp } from "@/components/AppProvider";
import { TopBar } from "@/components/TopBar";
import { Avatar } from "@/components/Avatar";
import { Sheet } from "@/components/Sheet";

export default function MessagesPage() {
  const { socket, request, me, setActiveDm, isOnline } = useApp();
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [composing, setComposing] = useState(false);

  const load = useCallback(() => {
    request<{ conversations: ConversationSummary[] }>("dm:list")
      .then((r) => setConversations(r.conversations))
      .catch(() => setConversations([]));
  }, [request]);

  useEffect(() => {
    load();
    setActiveDm("*");
    return () => setActiveDm(null);
  }, [load, setActiveDm]);

  // live: refresh the list whenever a DM to/from me arrives
  useEffect(() => {
    if (!socket) return;
    const onMsg = (_: DirectMessage) => load();
    socket.on("dm:message", onMsg);
    socket.on("dm:unread", load);
    return () => {
      socket.off("dm:message", onMsg);
      socket.off("dm:unread", load);
    };
  }, [socket, load]);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 pt-6 pb-24">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">Messages</h1>
          <button
            onClick={() => setComposing(true)}
            className="flex items-center gap-1.5 rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-on-accent hover:bg-emerald-400"
          >
            <PenSquare className="h-4 w-4" /> New
          </button>
        </div>

        {conversations === null ? (
          <div className="flex justify-center py-16 text-zinc-500">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : conversations.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-white/10 p-10 text-center text-zinc-500">
            <div className="mb-2 text-3xl">✉️</div>
            No conversations yet.
            <br />
            Tap <b className="text-zinc-300">New</b>, or hit <b className="text-zinc-300">Message</b> on anyone&apos;s profile.
          </div>
        ) : (
          <ul className="space-y-1">
            {conversations.map((c) => {
              const mine = c.lastMessage.fromId === me?.id;
              return (
                <li key={c.peer.id}>
                  <Link href={`/messages/${c.peer.id}`} className="flex items-center gap-3 rounded-2xl p-3 transition hover:bg-white/5">
                    <Avatar name={c.peer.name} color={c.peer.color} photo={c.peer.photoUrl} size="md" online={c.peer.isBot ? undefined : isOnline(c.peer.id)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={cn("truncate", c.unread ? "font-bold text-white" : "font-semibold text-zinc-100")}>{c.peer.name}</span>
                        <span className="shrink-0 text-xs text-zinc-500">{timeAgo(c.lastMessage.createdAt)}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <p className={cn("min-w-0 flex-1 truncate text-sm", c.unread ? "text-zinc-200" : "text-zinc-500")}>
                          {mine && <span className="text-zinc-500">You: </span>}
                          {c.lastMessage.text}
                        </p>
                        {c.unread > 0 && (
                          <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-sky-500 px-1.5 text-[11px] font-bold text-on-color">
                            {c.unread}
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </main>
      <NewMessageSheet open={composing} onClose={() => setComposing(false)} />
    </>
  );
}

function NewMessageSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { request, me, following, isOnline } = useApp();
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
              <Avatar name={u.name} color={u.color} photo={u.photoUrl} size="sm" online={u.isBot ? undefined : isOnline(u.id)} />
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
