"use client";

// Link live room (Donny t6066u/t6067u/t6070u/t6071u): every call link is a pre-seeded, always-alive room, like a Google
// Meet room. Shown on the call screen only for link calls (call.link): the room is live, who is in it (or "No one else
// is here yet"). Mic / camera are the call screen's one control row (t6093u).
import { useEffect, useState } from "react";
import { useApp } from "@/components/AppProvider";
import type { CallSnapshot } from "@/lib/calls/engine";
import { cn } from "@/lib/utils";
import css from "./calls.module.css";

/** How often the join screen refreshes who is in the room (read-only call:room). UI only: never ends anything. */
const ROOM_POLL_MS = 3_000;

export function linkRoomText(here: string[] | null, meId: string | null, names: Record<string, string>): string {
  if (!here) return "Joining the live room…";
  const others = here.filter((u) => u !== meId);
  // Same words as the app call screens (t6093u): alone in a link = "Waiting for <first name>…"
  if (others.length === 0) {
    const peer = Object.entries(names).find(([id]) => id !== meId)?.[1];
    return `Waiting for ${(peer ?? "someone").split(" ")[0]}…`;
  }
  return `In the live room with ${others.map((u) => (names[u] ?? "someone").split(" ")[0]).join(", ")}`;
}

export function LinkRoom({ s }: { s: CallSnapshot }) {
  const { request, me } = useApp();
  const call = s.call;
  const callId = call?.id ?? "";
  const [here, setHere] = useState<string[] | null>(null);

  useEffect(() => {
    if (!callId) return;
    let stop = false;
    const tick = () =>
      request<{ ok: boolean; here?: string[] }>("call:room", { callId })
        .then((r) => { if (!stop && r?.ok && Array.isArray(r.here)) setHere(r.here); })
        .catch(() => undefined);
    void tick();
    const iv = setInterval(tick, ROOM_POLL_MS);
    return () => { stop = true; clearInterval(iv); };
  }, [callId, request]);

  if (!call?.link) return null;
  const names: Record<string, string> = { [call.callerId]: call.caller.name, [call.calleeId]: call.callee.name };
  // Mic / camera live in the one floating control row (Controls), the same on every door and surface (t6093u).
  return (
    <div className={cn("pointer-events-auto flex flex-col items-center gap-2", css.banner)} data-testid="link-room">
      <div className="flex items-center gap-2 rounded-full bg-black/50 px-3 py-1 text-xs font-semibold backdrop-blur-md" data-testid="link-room-status">
        <span className={cn("h-2 w-2 rounded-full", here && here.some((u) => u !== (me?.id ?? null)) ? "bg-emerald-400" : "bg-white/50")} aria-hidden />
        {linkRoomText(here, me?.id ?? null, names)}
      </div>
    </div>
  );
}
