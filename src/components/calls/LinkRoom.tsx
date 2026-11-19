"use client";

// Link live room (Donny t6066u/t6067u/t6070u/t6071u): every call link is a pre-seeded, always-alive room, like a Google
// Meet room. Shown on the call screen only for link calls (call.link): the room is live, who is in it (or "No one else
// is here yet"), and Meet-style mute / camera toggles. Additive only: the toggles call the engine's existing
// toggleMute / toggleCam (the same calls the call screen's own Mute / Video buttons make), which flip the existing
// track (web: track mute / replaceTrack; native: tgcalls setMuted / setVideoEnabled). No new media path.
import { useEffect, useState } from "react";
import { Mic, MicOff, Video, VideoOff } from "lucide-react";
import { useApp } from "@/components/AppProvider";
import { callEngine, type CallSnapshot } from "@/lib/calls/engine";
import { cn } from "@/lib/utils";
import css from "./calls.module.css";

/** How often the join screen refreshes who is in the room (read-only call:room). UI only: never ends anything. */
const ROOM_POLL_MS = 3_000;

export function linkRoomText(here: string[] | null, meId: string | null, names: Record<string, string>): string {
  if (!here) return "Joining the live room…";
  const others = here.filter((u) => u !== meId);
  if (others.length === 0) return "You're in the live room · No one else is here yet";
  return `You're in the live room with ${others.map((u) => (names[u] ?? "someone").split(" ")[0]).join(", ")}`;
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
  const showCam = !!call.video && !(s.nativeAudio && !s.nativeVideo);
  const pill = (on: boolean) => cn("grid h-11 w-11 place-items-center rounded-full backdrop-blur-md", css.btn, on ? "bg-white text-zinc-900" : "bg-black/50 text-white");
  return (
    <div className={cn("pointer-events-auto flex flex-col items-center gap-2", css.banner)} data-testid="link-room">
      <div className="flex items-center gap-2 rounded-full bg-black/50 px-3 py-1 text-xs font-semibold backdrop-blur-md" data-testid="link-room-status">
        <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
        {linkRoomText(here, me?.id ?? null, names)}
      </div>
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => void callEngine.toggleMute()} aria-label={s.muted ? "Unmute" : "Mute"} aria-pressed={s.muted} className={pill(s.muted)} data-testid="link-room-mute">
          {s.muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>
        {showCam && (
          <button type="button" onClick={() => void callEngine.toggleCam()} aria-label={s.camOn ? "Turn camera off" : "Turn camera on"} aria-pressed={!s.camOn} className={pill(!s.camOn)} data-testid="link-room-camera">
            {s.camOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
          </button>
        )}
      </div>
    </div>
  );
}
