"use client";

// In-chat live banner while a drop-in audio chat in this DM is active: "Bea is live — Join".
import { useRouter } from "next/navigation";
import type { RoomCard } from "@/lib/types";
import { cn, firstName } from "@/lib/utils";
import { Avatar } from "../Avatar";
import { unlockAudio } from "@/lib/audioUnlock";
import { markAudio } from "@/hooks/useLiveKitAudio";
import s from "./rooms.module.css";

export function DropInBanner({ card, meId, peerId }: { card: RoomCard | null; meId?: string; peerId: string }) {
  const router = useRouter();
  if (!card || card.ended || !card.canJoin || !card.dropin) return null;
  const here = card.speakers;
  if (!here.length) return null;
  const imIn = here.some((p) => p.id === meId);
  const who = here.find((p) => p.id === peerId) ?? here.find((p) => p.id !== meId) ?? here[0];
  const text = imIn ? "You're in a drop-in audio chat" : `${firstName(who.name)} is live`;
  return (
    <div className={cn(s.bannerIn, "mx-3 mt-2 flex items-center gap-3 rounded-2xl border border-emerald-400/25 bg-emerald-500/10 px-3 py-2")} data-testid="dropin-banner">
      <div className={s.ringWrap}>
        <span className={s.ring} />
        <span className={s.ring} />
        <Avatar name={who.name} color={who.color} photo={who.photoUrl} size="xs" />
      </div>
      <div className="min-w-0 flex-1 text-sm">
        <div className="truncate font-semibold text-emerald-300">{text}</div>
        <div className="truncate text-xs text-zinc-400">{here.length === 1 ? "Drop-in audio" : `${here.length} talking`}</div>
      </div>
      <button
        type="button"
        onClick={() => {
          unlockAudio();
          markAudio("join-tap");
          try {
            sessionStorage.setItem("ol:join-tap", String(performance.now()));
          } catch {
            /* ignore */
          }
          router.push(`/room/${card.roomId}`);
        }}
        className={cn(s.press, "shrink-0 rounded-full bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-on-accent hover:bg-emerald-400")}
        data-testid="dropin-banner-join"
      >
        {imIn ? "Return" : "Join"}
      </button>
    </div>
  );
}
