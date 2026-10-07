"use client";

import Link from "next/link";
import { MessageCircle, Search, Settings, WifiOff } from "lucide-react";
import { Avatar } from "./Avatar";
import { useApp } from "./AppProvider";

export function TopBar() {
  const { me, offline, unreadDms } = useApp();
  return (
    <header data-app-header className="sticky top-0 z-30 border-b border-white/5 bg-app/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-2xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2 text-lg font-bold tracking-tight">
          <span className="text-2xl">🎙️</span> Open Lounge
        </Link>
        <div className="flex items-center gap-1">
          {/* only after >5 s offline — short blips reconnect silently */}
          {offline && (
            <span title="Offline — reconnecting" className="fade-in p-2 text-zinc-500" data-testid="offline-hint">
              <WifiOff className="h-4 w-4" />
            </span>
          )}
          <Link href="/explore" className="rounded-full p-2.5 text-zinc-300 hover:bg-white/5 hover:text-white" aria-label="Explore">
            <Search className="h-5 w-5" />
          </Link>
          <Link href="/messages" className="relative rounded-full p-2.5 text-zinc-300 hover:bg-white/5 hover:text-white" aria-label="Messages">
            <MessageCircle className="h-5 w-5" />
            {unreadDms > 0 && (
              <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-bold text-on-color">
                {unreadDms > 9 ? "9+" : unreadDms}
              </span>
            )}
          </Link>
          <Link href="/settings" className="rounded-full p-2.5 text-zinc-300 hover:bg-white/5 hover:text-white" aria-label="Settings">
            <Settings className="h-5 w-5" />
          </Link>
          {me && (
            <Link href={`/profile/${me.id}`} className="ml-1" aria-label="Your profile">
              <Avatar name={me.name} color={me.color} photo={me.photoUrl} size="sm" />
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
