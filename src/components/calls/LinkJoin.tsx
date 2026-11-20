"use client";

// Link join screen (Donny t6093u): every call link is one always-alive audio + video room. Tapping a link opens this
// screen first, like Google Meet's green room: your preview (browser: live camera; app: your avatar, the app opens the
// camera on Join), mic and camera toggles, who is already in the room, and Join. Choices are local until Join; Join
// opens the leg with them (the same join path as before). Rendered on every surface: browsers, and the app pages
// (its testid is not "call-screen", so the apps' native-call-UI style rule does not hide it).
import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { useApp } from "@/components/AppProvider";
import { callEngine, type CallSnapshot } from "@/lib/calls/engine";
import { useNativeMedia as appOwnsMedia } from "@/lib/calls/nativeMediaSession";
import { cn } from "@/lib/utils";
import css from "./calls.module.css";

const ROOM_POLL_MS = 3_000;

/** Join screen room line (same words on every surface). */
export function joinRoomText(here: string[] | null, meId: string | null, peerName: string): string {
  if (!here) return "Checking who's here…";
  const first = (peerName || "someone").split(" ")[0];
  return here.some((u) => u !== meId) ? `${first} is in the room` : `No one else is here yet`;
}

export function LinkJoin({ s }: { s: CallSnapshot }) {
  const { request, me } = useApp();
  const call = s.call!;
  const peer = s.role === "caller" ? call.callee : call.caller;
  const [here, setHere] = useState<string[] | null>(null);
  const [joining, setJoining] = useState(false);
  const vid = useRef<HTMLVideoElement>(null);
  const appMedia = typeof window !== "undefined" && appOwnsMedia();

  useEffect(() => {
    let stop = false;
    const tick = () =>
      request<{ ok: boolean; here?: string[] }>("call:room", { callId: call.id })
        .then((r) => { if (!stop && r?.ok && Array.isArray(r.here)) setHere(r.here); })
        .catch(() => undefined);
    void tick();
    const iv = setInterval(tick, ROOM_POLL_MS);
    return () => { stop = true; clearInterval(iv); };
  }, [call.id, request]);

  useEffect(() => {
    const el = vid.current;
    callEngine.attachVideo("local", el);
    return () => callEngine.attachVideo("local", null);
  }, [s.camOn]);

  const preview = s.camOn && !appMedia;
  const pill = (off: boolean) =>
    cn("grid h-14 w-14 place-items-center rounded-full backdrop-blur-md", css.btn, off ? "bg-red-500 text-white" : "bg-white/15 text-white");
  return (
    <div className={css.screen} role="dialog" aria-modal="true" aria-label={`Join call with ${peer.name}`} data-testid="link-join" data-ui="prejoin">
      <div className="absolute inset-0" aria-hidden>
        <div className={css.blob + " " + css.blobA} style={{ background: peer.color }} />
        <div className={css.blob + " " + css.blobB} style={{ background: "#6366f1" }} />
        <div className={css.shade} />
      </div>
      <div className="relative z-[6] mx-auto flex h-full w-full max-w-lg flex-col items-center justify-center gap-5 px-6 pt-[env(safe-area-inset-top)] pb-[calc(env(safe-area-inset-bottom)+16px)] text-center">
        <div className="min-w-0 max-w-full">
          <div className="text-[13px] font-medium uppercase tracking-wide text-white/60">Open Lounge call</div>
          <div className="mt-1 truncate text-2xl font-semibold" data-testid="link-join-name">{peer.name}</div>
          <div className="mt-1 flex items-center justify-center gap-2 text-sm text-white/80" data-testid="link-join-room">
            <span className={cn("h-2 w-2 rounded-full", here && here.some((u) => u !== me?.id) ? "bg-emerald-400" : "bg-white/40")} aria-hidden />
            {joinRoomText(here, me?.id ?? null, peer.name)}
          </div>
        </div>
        <div className="relative aspect-[3/4] w-full max-w-[280px] overflow-hidden rounded-3xl bg-zinc-900/80 shadow-xl sm:aspect-video sm:max-w-[420px]" data-testid="link-join-preview" data-cam={s.camOn ? "on" : "off"}>
          <video ref={vid} autoPlay playsInline muted className={cn("h-full w-full object-cover", !preview && "hidden")} style={{ transform: s.facing === "user" ? "scaleX(-1)" : undefined }} data-testid="link-join-video" />
          {!preview && (
            <div className="absolute inset-0 grid place-items-center">
              <div className="flex flex-col items-center gap-3">
                {me ? <Avatar name={me.name} color={me.color} photo={me.photoUrl ?? null} size="xl" /> : null}
                <span className="text-xs text-white/70">{s.camOn ? "Camera turns on when you join" : "Camera is off"}</span>
              </div>
            </div>
          )}
          {s.muted && (
            <span className="absolute bottom-2 left-2 grid h-7 w-7 place-items-center rounded-full bg-black/60" aria-label="Mic off"><MicOff className="h-4 w-4" /></span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <button type="button" onClick={() => callEngine.prejoinMute()} aria-label={s.muted ? "Turn on microphone" : "Turn off microphone"} aria-pressed={s.muted} className={pill(s.muted)} data-testid="link-join-mic">
            {s.muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
          </button>
          <button type="button" onClick={() => void callEngine.prejoinCam()} aria-label={s.camOn ? "Turn off camera" : "Turn on camera"} aria-pressed={!s.camOn} className={pill(!s.camOn)} data-testid="link-join-camera">
            {s.camOn ? <Video className="h-6 w-6" /> : <VideoOff className="h-6 w-6" />}
          </button>
        </div>
        {s.error && <div className="max-w-sm rounded-2xl bg-black/60 px-3 py-1.5 text-xs" role="status">{s.error}</div>}
        <div className="flex w-full max-w-[280px] flex-col gap-2">
          <button type="button" disabled={joining} onClick={() => { setJoining(true); void callEngine.joinFromPrejoin().finally(() => setJoining(false)); }} className="h-12 rounded-full bg-emerald-500 text-[15px] font-semibold text-white shadow-lg shadow-emerald-900/40 disabled:opacity-60" data-testid="link-join-button">
            {joining ? "Joining…" : "Join now"}
          </button>
          <button type="button" onClick={() => callEngine.cancelPrejoin()} className="h-10 rounded-full text-sm font-medium text-white/80 hover:bg-white/10" data-testid="link-join-cancel">
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
