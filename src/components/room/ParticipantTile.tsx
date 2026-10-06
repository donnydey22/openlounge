import { Hand } from "lucide-react";
import type { Participant } from "@/lib/types";
import { Avatar } from "../Avatar";
import { firstName } from "@/lib/utils";
import { cn } from "@/lib/utils";

export function ParticipantTile({
  p,
  isHost,
  isMe,
  followed,
  size,
  onClick,
  level = 0,
  onPodium = false,
  floatingEmoji,
}: {
  p: Participant;
  isHost: boolean;
  isMe: boolean;
  followed: boolean;
  size: "lg" | "md";
  onClick: () => void;
  /** 0–1 audio level for glow */
  level?: number;
  onPodium?: boolean;
  /** ephemeral reaction emoji floating above this tile */
  floatingEmoji?: string | null;
}) {
  const onStage = p.role !== "listener";
  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative flex flex-col items-center gap-1.5 rounded-2xl p-1 text-center outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50",
        onPodium && onStage && "podium-tile",
      )}
    >
      <div className="relative">
        <Avatar
          name={p.name}
          color={p.color}
          photo={p.photoUrl}
          size={size}
          speaking={onStage && p.speaking}
          level={onStage ? level : 0}
          muted={p.muted}
          showMuted={onStage}
          away={p.away}
          onPodium={onPodium && onStage}
        />
        {p.handRaised && (
          <span className="absolute -right-1 -bottom-1 z-[3] flex h-6 w-6 items-center justify-center rounded-full bg-amber-400 ring-2 ring-zinc-900">
            <Hand className="h-3.5 w-3.5 text-ink" />
          </span>
        )}
        {floatingEmoji && (
          <span className="reaction-float pointer-events-none absolute -top-2 left-1/2 z-[4] -translate-x-1/2 text-2xl" aria-hidden>
            {floatingEmoji}
          </span>
        )}
        {onPodium && onStage && (
          <span className="absolute -top-1 left-1/2 z-[3] -translate-x-1/2 rounded-full bg-amber-400 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-ink shadow">
            Podium
          </span>
        )}
      </div>
      <div className="flex max-w-[88px] items-center gap-1 text-xs text-zinc-300 group-hover:text-white">
        {isHost && (
          <span className="text-emerald-400" title="Host">
            ✳︎
          </span>
        )}
        <span className="truncate">{isMe ? "You" : firstName(p.name)}</span>
        {followed && !isMe && (
          <span className="text-[9px] text-sky-400" title="You follow">
            ●
          </span>
        )}
      </div>
      {p.away && <span className="-mt-1 text-[10px] text-zinc-500">reconnecting…</span>}
    </button>
  );
}
