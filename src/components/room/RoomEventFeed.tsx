"use client";

import type { RoomPresenceEvent } from "@/lib/types";
import { firstName } from "@/lib/utils";

export function RoomEventFeed({ events }: { events: RoomPresenceEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex flex-col items-center gap-1.5 px-3">
      {events.map((e) => (
        <div
          key={`${e.type}-${e.userId}-${e.at}`}
          className="room-event-in rounded-full border border-white/10 bg-zinc-900/90 px-3.5 py-1.5 text-xs font-medium text-zinc-200 shadow-lg backdrop-blur"
        >
          {e.type === "join" ? (
            <>
              <span className="text-emerald-400">↑</span> {firstName(e.name)} joined
            </>
          ) : (
            <>
              <span className="text-zinc-500">↓</span> {firstName(e.name)} left
            </>
          )}
        </div>
      ))}
    </div>
  );
}
