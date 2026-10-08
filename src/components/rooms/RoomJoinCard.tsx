"use client";

// Rich live audio room card shown in a DM: invite cards, drop-in cards and pasted openlounge.app/room links.
// Renders instantly from whatever is known (optimistic), then stays live over the WebSocket (useRoomCards):
// title, host avatar(s), speaker faces, listener count, Join → one tap into the room; "Ended" when it closes.
// While a joinable card is on screen the room route + the LiveKit client are pre-fetched and the LiveKit server
// is pre-connected, so Join → audio is as short as possible.

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Headphones, Lock, Mic, Radio } from "lucide-react";
import type { DmKind, RoomCard } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Avatar } from "../Avatar";
import { unlockAudio } from "@/lib/audioUnlock";
import { markAudio, prewarmLiveKit } from "@/hooks/useLiveKitAudio";
import { preconnectAudio } from "@/hooks/useRoomCards";
import s from "./rooms.module.css";

export function RoomJoinCard({
  roomId,
  card,
  kind,
  mine,
  fromName,
  className,
}: {
  roomId: string;
  /** live state (null = still loading → optimistic render) */
  card: RoomCard | null;
  kind: DmKind | "link";
  /** I sent it */
  mine: boolean;
  fromName?: string;
  className?: string;
}) {
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const ended = !!card?.ended;
  const dropin = kind === "dropin" || !!card?.dropin;
  // optimistic: until the server says otherwise, a fresh card is joinable (the room page re-checks on join)
  const canJoin = card ? card.canJoin && !card.ended : true;
  const noAccess = !!card && !card.ended && !card.canJoin;
  const title = card?.title || (dropin ? "Drop-in audio chat" : kind === "link" ? "Open Lounge room" : "Audio room");
  const total = card ? card.speakerCount + card.listenerCount : 0;

  // pre-warm while visible (cheap: route prefetch, LiveKit JS chunk, DNS/TLS to the SFU)
  useEffect(() => {
    if (!canJoin || !ref.current || typeof IntersectionObserver === "undefined") return;
    const el = ref.current;
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        io.disconnect();
        router.prefetch(`/room/${roomId}`);
        prewarmLiveKit();
        preconnectAudio();
      },
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [canJoin, roomId, router, card?.roomId]);

  const join = () => {
    if (!canJoin) return;
    unlockAudio(); // inside the tap: iOS / Android WebView autoplay unlock for the room audio
    markAudio("join-tap");
    try {
      sessionStorage.setItem("ol:join-tap", String(performance.now()));
    } catch {
      /* private mode */
    }
    router.push(`/room/${roomId}`);
  };

  const label = ended ? "Ended" : noAccess ? "Invite only" : dropin ? (mine ? "Open" : "Join") : "Join";
  return (
    <div
      ref={ref}
      data-testid="room-card"
      data-room-id={roomId}
      data-state={ended ? "ended" : noAccess ? "locked" : card ? "live" : "loading"}
      data-kind={kind}
      className={cn(
        s.cardIn,
        "w-[min(18rem,100%)] overflow-hidden rounded-[22px] border text-left shadow-lg",
        ended ? "border-white/5 bg-zinc-900/80" : "border-emerald-400/25 bg-gradient-to-b from-emerald-500/15 to-zinc-900",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 px-3.5 pt-3 text-[11px] font-semibold tracking-wide uppercase">
        {ended ? (
          <span className="text-zinc-500">{dropin ? "Drop-in ended" : "Room ended"}</span>
        ) : (
          <span className="flex items-center gap-1.5 text-emerald-400">
            <span className={cn(s.liveDot, "h-1.5 w-1.5 rounded-full bg-emerald-400")} />
            {dropin ? "Drop-in audio" : "Live room"}
          </span>
        )}
        {(card?.private || dropin) && <Lock className="ml-auto h-3 w-3 text-zinc-500" aria-label="Private" />}
      </div>
      <div className={cn("px-3.5 pt-1 text-[15px] leading-snug font-semibold", ended ? "text-zinc-400" : "text-zinc-50")} data-testid="room-card-title">
        {title}
      </div>
      {!ended && card && card.hosts.length > 0 && (
        <div className="truncate px-3.5 text-xs text-zinc-400">
          {card.hosts.length === 1 ? `Hosted by ${card.hosts[0].name}` : `Hosted by ${card.hosts.map((h) => h.name.split(" ")[0]).join(", ")}`}
        </div>
      )}
      {!card && fromName && <div className="px-3.5 text-xs text-zinc-400">{mine ? "You invited them" : `${fromName} invited you`}</div>}

      <div className="flex items-center gap-3 px-3.5 pt-3 pb-3">
        <div className="flex min-w-0 flex-1 items-center">
          {card && !ended && card.speakers.length > 0 ? (
            <div className="flex -space-x-2" data-testid="room-card-faces">
              {card.speakers.slice(0, 4).map((p) => (
                <div key={p.id} className="rounded-full ring-2 ring-zinc-900">
                  <Avatar name={p.name} color={p.color} photo={p.photoUrl} size="xs" />
                </div>
              ))}
            </div>
          ) : (
            <div className={cn("grid h-7 w-7 place-items-center rounded-full", ended ? "bg-zinc-800 text-zinc-500" : "bg-emerald-500/20 text-emerald-300")}>
              {dropin ? <Mic className="h-3.5 w-3.5" /> : <Radio className="h-3.5 w-3.5" />}
            </div>
          )}
          {card && !ended && (
            <div className="ml-2 min-w-0 text-[11px] leading-tight text-zinc-400" data-testid="room-card-counts">
              <div className="flex items-center gap-1">
                <Mic className="h-3 w-3" /> {card.speakerCount}
                <Headphones className="ml-1.5 h-3 w-3" /> <span data-testid="room-card-listeners">{card.listenerCount}</span>
              </div>
              <div className="truncate">{total === 0 ? "Waiting for people" : total === 1 ? "1 person here" : `${total} people here`}</div>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={join}
          disabled={!canJoin}
          data-testid="room-card-join"
          className={cn(
            s.press,
            "shrink-0 rounded-full px-4 py-2 text-sm font-semibold",
            canJoin ? "bg-emerald-500 text-on-accent hover:bg-emerald-400" : "bg-zinc-800 text-zinc-500",
          )}
          aria-label={canJoin ? `Join ${title}` : label}
        >
          {label}
        </button>
      </div>
    </div>
  );
}

/** A card as its own chat row (invite / drop-in messages): same alignment + avatar rules as a bubble. */
export function RoomCardRow({
  roomId,
  card,
  kind,
  mine,
  sep,
  sepTitle,
  first,
  last,
  peer,
  fromName,
  pending,
}: {
  roomId: string;
  card: RoomCard | null;
  kind: DmKind | "link";
  mine: boolean;
  sep: string | null;
  sepTitle?: string;
  first: boolean;
  last: boolean;
  peer: { name: string; color: string; photoUrl?: string | null } | null;
  fromName?: string;
  pending?: boolean;
}) {
  return (
    <div data-testid="dm-msg" data-mine={mine ? "1" : "0"} data-kind={kind}>
      {sep && (
        <div className="mt-4 mb-2 text-center text-[11px] font-medium text-zinc-500" title={sepTitle}>
          {sep}
        </div>
      )}
      <div className={cn("flex items-end gap-2", mine ? "justify-end pl-12" : "justify-start pr-12", first ? "mt-2" : "mt-[3px]", pending && "opacity-70")}>
        {!mine && <div className="w-7 shrink-0">{last && peer && <Avatar name={peer.name} color={peer.color} photo={peer.photoUrl} size="xs" />}</div>}
        <RoomJoinCard roomId={roomId} card={card} kind={kind} mine={mine} fromName={fromName} />
      </div>
    </div>
  );
}

/** Live card(s) under a text bubble that contains openlounge.app room links. */
export function RoomLinkCards({ ids, cards, mine }: { ids: string[]; cards: Map<string, RoomCard | null>; mine: boolean }) {
  return (
    <div className={cn("mt-1 flex flex-col gap-1", mine ? "items-end pl-12" : "items-start pr-12 pl-9")} data-testid="room-link-cards">
      {ids.map((id) => (
        <RoomJoinCard key={id} roomId={id} card={cards.get(id) ?? null} kind="link" mine={mine} />
      ))}
    </div>
  );
}
