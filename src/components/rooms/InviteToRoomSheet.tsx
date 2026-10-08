"use client";

// Inside a live room: "Invite" → pick DM contacts (recent conversations first, then people you follow) → each
// gets a live invite card in their DM (+ a push that opens the room).

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Search } from "lucide-react";
import type { ConversationSummary, PublicUser, RoomCard } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useApp } from "../AppProvider";
import { Sheet } from "../Sheet";
import { Avatar } from "../Avatar";
import { primeRoomCard } from "@/hooks/useRoomCards";
import s from "./rooms.module.css";

const MAX = 20;

export function InviteToRoomSheet({ roomId, open, onClose, exclude }: { roomId: string; open: boolean; onClose: () => void; exclude: Set<string> }) {
  const { request, following, me, toast, reportError } = useApp();
  const [people, setPeople] = useState<PublicUser[] | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPicked(new Set());
    setQ("");
    let alive = true;
    Promise.all([
      request<{ conversations: ConversationSummary[] }>("dm:list", {}).catch(() => ({ conversations: [] as ConversationSummary[] })),
      request<{ users: PublicUser[] }>("users:list", {}).catch(() => ({ users: [] as PublicUser[] })),
    ]).then(([dms, all]) => {
      if (!alive) return;
      const seen = new Set<string>();
      const out: PublicUser[] = [];
      for (const c of dms.conversations) if (!seen.has(c.peer.id) && !c.peer.isBot) (seen.add(c.peer.id), out.push(c.peer));
      for (const u of all.users) if (!seen.has(u.id) && following.has(u.id) && !u.isBot) (seen.add(u.id), out.push(u));
      setPeople(out.filter((u) => u.id !== me?.id));
    });
    return () => {
      alive = false;
    };
  }, [open, request, following, me?.id]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (people ?? []).filter((u) => !t || u.name.toLowerCase().includes(t) || u.username.toLowerCase().includes(t));
  }, [people, q]);

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else if (n.size < MAX) n.add(id);
      return n;
    });

  const send = async () => {
    if (!picked.size) return;
    setSending(true);
    try {
      const r = await request<{ sent: number; card: RoomCard }>("room:inviteDm", { roomId, to: [...picked] });
      primeRoomCard(r.card);
      toast(r.sent === 1 ? "🎙️ Invite sent" : `🎙️ ${r.sent} invites sent`);
      onClose();
    } catch (e) {
      reportError(e);
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Invite to this room"
      footer={
        <button
          type="button"
          onClick={send}
          disabled={!picked.size || sending}
          data-testid="invite-send"
          className={cn(s.press, "flex w-full items-center justify-center gap-2 rounded-full bg-emerald-500 py-3 text-sm font-semibold text-on-accent hover:bg-emerald-400 disabled:opacity-50")}
        >
          {sending && <Loader2 className="h-4 w-4 animate-spin" />}
          {picked.size ? `Send invite${picked.size > 1 ? `s (${picked.size})` : ""}` : "Pick people"}
        </button>
      }
    >
      <div className="relative mb-2">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search people"
          className="w-full rounded-full bg-zinc-800 py-2.5 pr-4 pl-9 text-[16px] outline-none placeholder:text-zinc-500"
          data-testid="invite-search"
        />
      </div>
      <div className="max-h-[50dvh] space-y-0.5 overflow-y-auto overscroll-contain" data-testid="invite-list">
        {people === null ? (
          <div className="flex justify-center py-8 text-zinc-500">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : shown.length === 0 ? (
          <p className="py-8 text-center text-sm text-zinc-500">{people.length ? "No matches" : "Message or follow people to invite them here."}</p>
        ) : (
          shown.map((u) => {
            const inRoom = exclude.has(u.id);
            const on = picked.has(u.id);
            return (
              <button
                key={u.id}
                type="button"
                disabled={inRoom}
                onClick={() => toggle(u.id)}
                data-testid="invite-person"
                data-user-id={u.id}
                className={cn("flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-white/5", inRoom && "opacity-50")}
              >
                <Avatar name={u.name} color={u.color} photo={u.photoUrl} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{u.name}</span>
                  <span className="block truncate text-xs text-zinc-500">{inRoom ? "Already here" : `@${u.username}`}</span>
                </span>
                <span className={cn("grid h-6 w-6 place-items-center rounded-full border transition-[transform,opacity]", on ? "scale-100 border-emerald-400 bg-emerald-500 text-on-accent" : "border-white/20")}>
                  {on && <Check className="h-3.5 w-3.5" />}
                </span>
              </button>
            );
          })
        )}
      </div>
    </Sheet>
  );
}
