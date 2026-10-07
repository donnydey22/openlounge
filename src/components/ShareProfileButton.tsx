"use client";

import { Share2 } from "lucide-react";
import { shareLink } from "@/lib/native";
import { profileLink } from "@/lib/links";
import { cn } from "@/lib/utils";

export function ShareProfileButton({ username, name, isMe, className, iconOnly, onCopied }: { username: string; name: string; isMe?: boolean; className?: string; iconOnly?: boolean; onCopied?: () => void }) {
  return (
    <button
      onClick={async () => {
        const how = await shareLink(isMe ? "Find me on Open Lounge 🎙️" : `${name} on Open Lounge 🎙️`, profileLink(username));
        if (how === "copied") onCopied?.();
      }}
      aria-label="Share profile"
      className={cn(
        iconOnly
          ? "rounded-full border border-white/12 p-2.5 text-zinc-300 hover:bg-white/5"
          : "flex items-center gap-2 rounded-full border border-white/15 px-4 py-2 text-sm font-semibold text-zinc-200 hover:bg-white/5",
        className,
      )}
    >
      <Share2 className="h-4 w-4" />
      {!iconOnly && " Share profile"}
    </button>
  );
}
