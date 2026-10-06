"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { PublicUser } from "@/lib/types";
import { useApp } from "@/components/AppProvider";
import { TopBar } from "@/components/TopBar";
import { RoomCard } from "@/components/RoomCard";
import { UserRow } from "@/components/UserRow";

export default function ExplorePage() {
  const { request, rooms, me } = useApp();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [q, setQ] = useState("");

  useEffect(() => {
    request<{ users: PublicUser[] }>("users:list")
      .then((r) => setUsers(r.users))
      .catch(() => {});
  }, [request]);

  const needle = q.trim().toLowerCase();
  const people = useMemo(
    () => users.filter((u) => u.id !== me?.id && (!needle || u.name.toLowerCase().includes(needle) || u.bio.toLowerCase().includes(needle))),
    [users, needle, me?.id],
  );
  const matchingRooms = useMemo(
    () =>
      needle
        ? rooms.filter((r) => [r.title, r.topic, r.description, r.hostName].some((s) => s.toLowerCase().includes(needle)))
        : [],
    [rooms, needle],
  );

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 pt-6 pb-24">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search people, rooms and topics"
            className="w-full rounded-full border border-white/10 bg-zinc-900 py-3 pr-4 pl-11 outline-none placeholder:text-zinc-600 focus:border-emerald-500/60"
          />
        </div>

        {needle && (
          <section className="mt-6">
            <h2 className="mb-3 text-sm font-semibold text-zinc-400">Rooms</h2>
            <div className="space-y-3">
              {matchingRooms.map((r) => (
                <RoomCard key={r.id} room={r} />
              ))}
              {matchingRooms.length === 0 && <p className="text-sm text-zinc-600">No live rooms match “{q}”.</p>}
            </div>
          </section>
        )}

        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold text-zinc-400">{needle ? "People" : "People to follow"}</h2>
          <div className="space-y-0.5">
            {people.map((u) => (
              <UserRow key={u.id} user={u} />
            ))}
            {people.length === 0 && <p className="text-sm text-zinc-600">No people match “{q}”.</p>}
          </div>
        </section>
      </main>
    </>
  );
}
