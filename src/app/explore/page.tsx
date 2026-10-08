"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { GlobalResults, SearchSuggestions } from "@/components/search/SearchResults";
import { isEmptyQuery, parseSearchQuery, typingToken } from "@/lib/searchQuery";
import { Search } from "lucide-react";
import type { PublicUser } from "@/lib/types";
import { useApp } from "@/components/AppProvider";
import { TopBar } from "@/components/TopBar";
import { RoomCard } from "@/components/RoomCard";
import { FeaturedSponsored } from "@/components/ads/FeaturedSponsored";
import { UserRow } from "@/components/UserRow";

export default function ExplorePage() {
  const { request, rooms, me } = useApp();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const router = useRouter();
  // ?q= deep link (tapped #tag / "All chats" from a chat); kept in the URL so Back returns to the same search
  const [q, setQ] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // read after mount (not during render) so the server HTML and the first client render match
    setQ(new URLSearchParams(window.location.search).get("q") ?? "");
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => {
      const cur = new URLSearchParams(window.location.search).get("q") ?? "";
      if (cur !== q)
        router.replace(q ? `/explore?q=${encodeURIComponent(q)}` : "/explore", {
          scroll: false,
        });
    }, 400);
    return () => clearTimeout(t);
  }, [q, router, ready]);
  const parsed = useMemo(() => parseSearchQuery(q), [q]);
  // "#…" / "@…" anywhere in the query → index-backed search (messages in my chats, rooms, people)
  const tagged = parsed.tags.length > 0 || parsed.mentions.length > 0;
  const typing = typingToken(q);

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
    () => (needle ? rooms.filter((r) => [r.title, r.topic, r.description, r.hostName].some((s) => s.toLowerCase().includes(needle))) : []),
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
            placeholder="Search people, rooms, #topics and @names"
            enterKeyHint="search"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-testid="explore-search"
            className="w-full rounded-full border border-white/10 bg-zinc-900 py-3 pr-4 pl-11 outline-none placeholder:text-zinc-600 focus:border-emerald-500/60"
          />
        </div>

        {typing && <SearchSuggestions q={q} onPick={setQ} />}

        {tagged && !isEmptyQuery(parsed) ? (
          <GlobalResults q={q} />
        ) : (
          <>
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

            {!needle && <FeaturedSponsored placement="explore" className="mt-6" />}
            <section className="mt-6">
              <h2 className="mb-2 text-sm font-semibold text-zinc-400">{needle ? "People" : "People to follow"}</h2>
              <div className="space-y-0.5">
                {people.map((u) => (
                  <UserRow key={u.id} user={u} />
                ))}
                {people.length === 0 && (
                  <p className="text-sm text-zinc-600">{needle ? `No people match “${q}”.` : "No one else is here yet. Invite a few friends!"}</p>
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </>
  );
}
