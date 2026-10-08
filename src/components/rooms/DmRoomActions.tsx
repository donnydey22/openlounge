"use client";

// The DM composer's "+" : start a private drop-in audio chat with this person, or send them a live invite card
// for the room you're in (or any live room in the hallway).

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AudioLines, Loader2, Plus, Radio } from "lucide-react";
import type { DirectMessage, RoomCard } from "@/lib/types";
import { cn, firstName } from "@/lib/utils";
import { useApp } from "../AppProvider";
import { Sheet } from "../Sheet";
import { unlockAudio } from "@/lib/audioUnlock";
import { markAudio, prewarmLiveKit } from "@/hooks/useLiveKitAudio";
import { primeRoomCard } from "@/hooks/useRoomCards";
import s from "./rooms.module.css";

export function DmRoomActions({
  peerId,
  peerName,
  disabled,
  onSent,
}: {
  peerId: string;
  peerName: string;
  disabled?: boolean;
  /** a card message was created (merged into the thread right away, before the echo) */
  onSent?: (m: DirectMessage) => void;
}) {
  const { request, rooms, reportError, toast } = useApp();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [current, setCurrent] = useState<RoomCard | null>(null);

  useEffect(() => {
    if (!open) return;
    prewarmLiveKit();
    request<{ card: RoomCard | null }>("room:current", {})
      .then((r) => setCurrent(r.card && !r.card.ended ? r.card : null))
      .catch(() => setCurrent(null));
  }, [open, request]);

  const dropIn = useCallback(async () => {
    unlockAudio(); // inside the tap
    markAudio("join-tap");
    try {
      sessionStorage.setItem("ol:join-tap", String(performance.now()));
    } catch {
      /* private mode */
    }
    setBusy("dropin");
    try {
      const r = await request<{ roomId: string; message: DirectMessage | null; card: RoomCard }>("dropin:start", { peerId });
      primeRoomCard(r.card);
      if (r.message) onSent?.(r.message);
      setOpen(false);
      router.push(`/room/${r.roomId}`);
    } catch (e) {
      reportError(e);
    } finally {
      setBusy(null);
    }
  }, [request, peerId, onSent, router, reportError]);

  const invite = useCallback(
    async (roomId: string) => {
      setBusy(roomId);
      try {
        const r = await request<{ card: RoomCard; results: { ok: boolean; messageId?: string }[] }>("room:inviteDm", { roomId, to: [peerId] });
        primeRoomCard(r.card);
        setOpen(false);
        toast(`🎙️ Invite sent to ${firstName(peerName)}`);
      } catch (e) {
        reportError(e);
      } finally {
        setBusy(null);
      }
    },
    [request, peerId, peerName, reportError, toast],
  );

  const live = rooms.filter((r) => r.id !== current?.roomId).slice(0, 5);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className={cn(s.press, "mb-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-full bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40")}
        aria-label="Audio: drop-in chat or room invite"
        data-testid="dm-plus"
      >
        <Plus className="h-5 w-5" />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Talk live">
        <div className="space-y-2" data-testid="dm-audio-sheet">
          <button
            type="button"
            onClick={dropIn}
            disabled={!!busy}
            data-testid="dm-dropin-start"
            className={cn(s.press, "flex w-full items-center gap-3 rounded-2xl bg-emerald-500 px-4 py-3.5 text-left font-semibold text-on-accent hover:bg-emerald-400 disabled:opacity-70")}
          >
            {busy === "dropin" ? <Loader2 className="h-5 w-5 animate-spin" /> : <AudioLines className="h-5 w-5" />}
            <span className="min-w-0 flex-1">
              <span className="block">Start a drop-in audio chat</span>
              <span className="block text-xs font-normal opacity-80">Private: only you and {firstName(peerName)} can join</span>
            </span>
          </button>
          {current && (
            <button
              type="button"
              onClick={() => invite(current.roomId)}
              disabled={!!busy}
              data-testid="dm-invite-current"
              className="flex w-full items-center gap-3 rounded-2xl border border-white/10 px-4 py-3 text-left hover:bg-white/5"
            >
              {busy === current.roomId ? <Loader2 className="h-5 w-5 animate-spin text-emerald-400" /> : <Radio className="h-5 w-5 text-emerald-400" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">Invite to “{current.title}”</span>
                <span className="block text-xs text-zinc-500">The room you&apos;re in now</span>
              </span>
            </button>
          )}
          {live.length > 0 && (
            <>
              <div className="px-1 pt-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Share a live room</div>
              {live.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => invite(r.id)}
                  disabled={!!busy}
                  data-testid="dm-invite-room"
                  className="flex w-full items-center gap-3 rounded-2xl px-4 py-2.5 text-left hover:bg-white/5"
                >
                  {busy === r.id ? <Loader2 className="h-4 w-4 animate-spin text-emerald-400" /> : <Radio className="h-4 w-4 text-zinc-400" />}
                  <span className="min-w-0 flex-1 truncate text-sm">{r.title}</span>
                  <span className="text-xs text-zinc-500">{r.speakerCount + r.listenerCount} here</span>
                </button>
              ))}
            </>
          )}
        </div>
      </Sheet>
    </>
  );
}
