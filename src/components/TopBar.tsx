"use client";

import Link from "next/link";
import { MessageCircle, Search, Settings, WifiOff } from "lucide-react";
import { Avatar } from "./Avatar";
import { useApp } from "./AppProvider";
import { HeaderWordmark } from "./brand/HeaderWordmark";

export function TopBar() {
  const { me, offline, unreadDms } = useApp();
  return (
    <header data-app-header className="sticky top-0 z-30 border-b border-white/5 bg-app/80 pt-[env(safe-area-inset-top,0px)] backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-2xl items-center justify-between gap-2 px-4 max-[389px]:gap-1.5 max-[389px]:px-3">
        {/* below 390px the wordmark steps down (no clamp(): Chrome 69 WebView) and the icons tighten, so it fits beside them down to 280px */}
        <Link href="/" className="flex min-w-0 shrink items-center text-lg max-[389px]:text-base max-[364px]:text-[15px] max-[339px]:text-[13.5px] max-[309px]:text-[12.5px]" aria-label="Open Lounge — hallway">
          <span className="inline-flex min-w-0 items-center gap-2 max-[389px]:gap-1">
            <span className="ol-head-mic shrink-0 text-2xl max-[389px]:text-xl" aria-hidden="true">🎙️</span>
            <HeaderWordmark />
          </span>
        </Link>
        <div className="flex shrink-0 items-center gap-1 max-[389px]:gap-0">
          {/* only after >5 s offline — short blips reconnect silently */}
          {offline && (
            <span title="Offline — reconnecting" className="fade-in p-2 text-zinc-500" data-testid="offline-hint">
              <WifiOff className="h-4 w-4" />
            </span>
          )}
          <Link href="/explore" className="rounded-full p-2.5 text-zinc-300 hover:bg-white/5 hover:text-white max-[389px]:p-2 max-[339px]:p-1.5" aria-label="Explore">
            <Search className="h-5 w-5" />
          </Link>
          <Link href="/messages" className="relative rounded-full p-2.5 text-zinc-300 hover:bg-white/5 hover:text-white max-[389px]:p-2 max-[339px]:p-1.5" aria-label="Messages">
            <MessageCircle className="h-5 w-5" />
            {unreadDms > 0 && (
              <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-sky-500 px-1 text-[10px] font-bold text-on-color">
                {unreadDms > 9 ? "9+" : unreadDms}
              </span>
            )}
          </Link>
          <Link href="/settings" className="rounded-full p-2.5 text-zinc-300 hover:bg-white/5 hover:text-white max-[389px]:p-2 max-[339px]:p-1.5" aria-label="Settings">
            <Settings className="h-5 w-5" />
          </Link>
          {me && (
            <Link href={`/profile/${me.id}`} className="ml-1 shrink-0 max-[389px]:ml-0.5" aria-label="Your profile">
              <Avatar name={me.name} color={me.color} photo={me.photoUrl} size="sm" />
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
