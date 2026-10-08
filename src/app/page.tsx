"use client";

import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { RoomCard } from "@/components/RoomCard";
import { SponsoredSlot } from "@/components/sponsored/Sponsored";
import { FeaturedSponsored } from "@/components/ads/FeaturedSponsored";
import { CreateRoomSheet } from "@/components/CreateRoomSheet";
import { useApp } from "@/components/AppProvider";
import { TOPIC_EMOJI, cn, firstName } from "@/lib/utils";

export default function HallwayPage() {
  const { me, rooms, following, roomsLoaded } = useApp();
  const [creating, setCreating] = useState(false);
  const [topic, setTopic] = useState<string>("All");

  const topics = useMemo(() => ["All", ...Array.from(new Set(rooms.map((r) => r.topic)))], [rooms]);
  const visible = topic === "All" ? rooms : rooms.filter((r) => r.topic === topic);
  const totalListening = rooms.reduce((n, r) => n + r.listenerCount + r.speakerCount, 0);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 pb-32">
        {/* top padding leaves a slot for the in-app notification banner between the header and the greeting */}
        <section className="pb-4" style={{ paddingTop: "max(1.5rem, calc(var(--ol-banner-h) + 2 * var(--ol-banner-gap)))" }}>
          <h1 className="text-2xl font-bold tracking-tight">Hey {me ? firstName(me.name) : ""} 👋</h1>
          <p className="mt-1 text-sm text-zinc-400">
            {rooms.length} live room{rooms.length === 1 ? "" : "s"} · {totalListening} people in the hallway right now
          </p>
        </section>

        <div className="no-scrollbar -mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {topics.map((t) => (
            <button
              key={t}
              onClick={() => setTopic(t)}
              className={cn(
                "shrink-0 rounded-full border px-3.5 py-1.5 text-sm transition",
                topic === t
                  ? "border-white/80 bg-white text-on-accent"
                  : "border-white/10 text-zinc-400 hover:border-white/20 hover:text-zinc-200",
              )}
            >
              {t === "All" ? "🔥 All" : `${TOPIC_EMOJI[t] ?? "✨"} ${t}`}
            </button>
          ))}
        </div>

        <div className="space-y-4">
          {!roomsLoaded &&
            rooms.length === 0 &&
            [0, 1, 2].map((i) => <div key={i} className="skeleton h-40 rounded-3xl" aria-hidden />)}
          {roomsLoaded && <FeaturedSponsored placement="hallway" />}
          {visible.map((r) => (
            <RoomCard key={r.id} room={r} highlight={r.speakers.some((s) => following.has(s.id) || s.id === me?.id)} />
          ))}
          {roomsLoaded && visible.length === 0 && (
            <div className="rounded-3xl border border-dashed border-white/10 p-10 text-center text-zinc-500">
              <div className="mb-2 text-3xl">🌙</div>
              It&apos;s quiet in here. Start a room and get the conversation going.
            </div>
          )}
          {roomsLoaded && <SponsoredSlot placement="rooms" />}
        </div>
      </main>

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center bg-gradient-to-t from-app via-app/90 to-transparent pt-10 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <button
          onClick={() => setCreating(true)}
          className="pointer-events-auto flex items-center gap-2 rounded-full bg-emerald-500 px-6 py-3.5 font-semibold text-on-accent shadow-lg shadow-emerald-500/20 transition hover:scale-[1.02] hover:bg-emerald-400 active:scale-95"
        >
          <Plus className="h-5 w-5" /> Start a room
        </button>
      </div>

      <CreateRoomSheet open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
