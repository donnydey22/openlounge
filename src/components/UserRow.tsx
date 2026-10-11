"use client";

import { useDisplayUser } from "@/lib/userDisplay";
import Link from "next/link";
import type { PublicUser } from "@/lib/types";
import { compact } from "@/lib/utils";
import { Avatar } from "./Avatar";
import { useApp } from "./AppProvider";
import { usePresence } from "@/hooks/usePresence";
import { haptic } from "@/lib/native";

export function FollowButton({ userId, small }: { userId: string; small?: boolean }) {
  const { me, following, follow } = useApp();
  if (me?.id === userId) return null;
  const on = following.has(userId);
  return (
    <button
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        haptic(on ? "light" : "success");
        follow(userId, !on);
      }}
      className={
        "shrink-0 rounded-full font-semibold transition " +
        (small ? "px-3.5 py-1.5 text-xs " : "px-6 py-2.5 text-sm ") +
        (on ? "border border-white/15 text-zinc-200 hover:bg-white/5" : "bg-sky-500 text-on-color hover:bg-sky-400")
      }
    >
      {on ? "Following" : "Follow"}
    </button>
  );
}

export function UserRow({ user: raw }: { user: PublicUser }) {
  const user = useDisplayUser(raw)!;
  // live presence (pushed over the WebSocket), not the snapshot captured when the list was fetched
  const { online, dot } = usePresence(user.id, user.lastSeenAt);
  const { isLive } = useApp();
  return (
    <Link href={`/profile/${user.id}`} className="flex items-center gap-3 rounded-2xl p-2.5 transition hover:bg-white/5">
      <Avatar name={user.name} color={user.color} photo={user.photoUrl} size="sm" presence={user.isBot ? null : dot} live={isLive(user.id)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate font-medium">
          <span className="truncate">{user.name}</span>
          {online && <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-400">Online</span>}
        </div>
        <div className="truncate text-xs text-zinc-500">
          {user.bio || `@${user.username} · ${compact(user.followers)} followers`}
        </div>
      </div>
      <FollowButton userId={user.id} small />
    </Link>
  );
}
