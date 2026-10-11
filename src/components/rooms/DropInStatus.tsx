"use client";

// Drop-in audio chat status at the top of the room: ringing (expanding rings around the people you're waiting for),
// connecting, then a short "connected" pop that animates out. transform/opacity only; reduced motion → static.

import { useEffect, useRef, useState } from "react";
import type { RoomState } from "@/lib/types";
import type { AudioStatus } from "@/hooks/useLiveKitAudio";
import { cn, firstName } from "@/lib/utils";
import { Avatar } from "../Avatar";
import s from "./rooms.module.css";

export function DropInStatus({ room, meId, audio }: { room: RoomState; meId?: string; audio: AudioStatus }) {
  const others = room.participants.filter((p) => p.userId !== meId);
  const waiting = room.invited ?? [];
  const audioOk = audio === "connected" || audio === "unavailable" || audio === "off";
  const live = others.length > 0 && audioOk;
  const [phase, setPhase] = useState<"wait" | "pop" | "done">(live ? "done" : "wait");
  const wasLive = useRef(live);
  useEffect(() => {
    if (live && !wasLive.current) {
      setPhase("pop");
      const t = setTimeout(() => setPhase("done"), 420);
      wasLive.current = live;
      return () => clearTimeout(t);
    }
    if (!live) setPhase("wait");
    wasLive.current = live;
  }, [live]);
  if (phase === "done") return null;
  const target = waiting[0] ?? null;
  const label =
    audio === "connecting" ? "Connecting audio…" : audio === "reconnecting" ? "Reconnecting…" : others.length === 0 ? (target ? `Ringing ${firstName(target.name)}…` : "Waiting for others to join…") : "Connected";
  return (
    <div
      className={cn("mt-4 flex items-center gap-4 rounded-2xl border border-emerald-400/20 bg-emerald-500/5 px-4 py-3", phase === "pop" && s.connected)}
      data-testid="dropin-status"
      data-phase={phase}
      aria-live="polite"
    >
      <div className={cn(s.ringWrap, "h-12 w-12")}>
        <span className={s.ring} />
        <span className={s.ring} />
        <span className={s.ring} />
        <div className={s.breathe}>
          {target ? <Avatar name={target.name} color={target.color} photo={target.photoUrl} size="sm" /> : <div className="h-10 w-10 rounded-full bg-emerald-500/30" />}
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-emerald-300">{label}</div>
        <div className="text-xs text-zinc-400">Private drop-in · ends when everyone leaves</div>
      </div>
    </div>
  );
}
