"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Radio } from "lucide-react";
import { TopBar } from "@/components/TopBar";
import { Avatar } from "@/components/Avatar";
import { useApp } from "@/components/AppProvider";
import { liveFor, markLiveRead, useLiveNow } from "@/lib/liveNow";

/** "Live now": live-room notifications you were sent (or that quiet hours / the throttle held back), so a missed
 *  banner isn't lost. Live rooms only — an entry disappears the moment its room ends. Tap joins. */
export default function LiveNowPage() {
  const { socket, connected, status } = useApp();
  const { entries, loaded, unread } = useLiveNow(socket, connected && status === "ready");
  const [now, setNow] = useState(() => Date.now());

  // "live for" ticks once a minute (static otherwise)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  // opening the list reads it (the bell badge clears on every tab / device)
  useEffect(() => {
    if (loaded && unread > 0) markLiveRead(socket);
  }, [loaded, unread, socket]);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 pt-4 pb-24 max-[339px]:px-3" data-testid="live-now">
        <Link href="/" className="mb-3 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200">
          <ChevronLeft className="h-4 w-4" /> Hallway
        </Link>
        <h1 className="mb-1 text-2xl font-bold tracking-tight">Live now</h1>
        <p className="mb-5 text-sm text-zinc-400">Rooms people you follow started or joined. They leave this list when the room ends.</p>
        {!loaded ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-[68px] rounded-2xl bg-zinc-900/70" />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-400/10 text-emerald-400">
              <Radio className="h-5 w-5" />
            </span>
            <p className="font-semibold">Nothing live right now</p>
            <p className="mt-1 text-sm text-zinc-500">When someone you follow goes live, it shows up here.</p>
          </div>
        ) : (
          <ul className="overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/70">
            {entries.map((e, i) => {
              const who = e.actor;
              return (
                <li key={e.roomId} className={i ? "border-t border-white/5" : ""}>
                  <Link href={e.url} className="flex items-center gap-3 px-4 py-3 transition hover:bg-white/5 max-[339px]:px-3" data-testid="live-entry">
                    {who ? (
                      <Avatar name={who.name} color={who.color} photo={who.photoUrl} size="sm" live />
                    ) : (
                      <span className="openlounge-hex flex h-10 w-10 shrink-0 items-center justify-center bg-emerald-500/20 text-emerald-300">
                        <Radio className="h-4 w-4" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center">
                        <span className="truncate text-sm font-semibold">{e.title}</span>
                        {e.readAt === null && <span className="ml-2 h-2 w-2 shrink-0 rounded-full bg-emerald-400" aria-label="New" />}
                      </span>
                      <span className="block truncate text-xs text-zinc-400">{e.room?.title || "Untitled room"}</span>
                      <span className="mt-0.5 flex items-center text-[11px] text-zinc-500">
                        <span className="live-dot mr-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" aria-hidden />
                        <span className="truncate">
                          Live {e.room ? liveFor(e.room.startedAt, now) : ""} · {e.room?.count ?? 0} in the room
                        </span>
                      </span>
                    </span>
                    <span className="shrink-0 rounded-full bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-on-color max-[339px]:px-2.5">Join</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </>
  );
}
