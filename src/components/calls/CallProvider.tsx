"use client";

// Mounts the call engine for the whole app: binds it to the socket + signed-in user, resumes a live call after a
// reconnect / reload, and renders the call screen (or the minimized green bar) above every page.
import { useEffect } from "react";
import dynamic from "next/dynamic";
import { useApp } from "@/components/AppProvider";
import { callEngine } from "@/lib/calls/engine";
import { installAudioUnlock } from "@/lib/audioUnlock";
import { useCall } from "./useCall";

// the call UI (and livekit-client inside the engine's dynamic import) only loads when a call exists
const CallOverlay = dynamic(() => import("./CallOverlay").then((m) => m.CallOverlay), { ssr: false });

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { socket, connected, me, toast } = useApp();
  const s = useCall();
  const meId = me?.id ?? null;

  useEffect(() => {
    callEngine?.bind(socket, meId);
  }, [socket, meId]);

  // unlock the shared AudioContext on the first tap anywhere (and after iOS interruptions) so an incoming call's
  // ringtone can play even though it arrives over the WebSocket, outside any gesture
  useEffect(() => installAudioUnlock(), []);

  useEffect(() => {
    if (connected && meId) void callEngine?.resume();
  }, [connected, meId]);

  // errors with no call screen up (e.g. "You can call Bea once they message you") → app toast
  useEffect(() => {
    if (s.error && !s.ui) {
      toast(s.error);
      callEngine?.clearError();
    }
  }, [s.error, s.ui, toast]);

  // leaving the page mid-call: hang up cleanly instead of leaving the other side on a dead line
  useEffect(() => {
    const onHide = (e: PageTransitionEvent) => {
      if (e.persisted) return; // back/forward cache: the page may come right back
      const st = callEngine?.snapshot();
      if (st?.call?.id && (st.ui === "outgoing" || st.ui === "active" || st.ui === "connecting")) socket?.emit("call:hangup", { callId: st.call.id });
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [socket]);

  // Native wrappers (CallKit / Android call notification, NATIVE_SPEC.md §5) drive the call from outside the page:
  //   window.dispatchEvent(new CustomEvent("openlounge:native-call", { detail: { type: "call:hangup" } }))
  // types: call:hangup | call:accept | call:decline | call:mute {muted}. CustomEvents can only come from code running in
  // this page (the wrapper's injectJavaScript), never from other origins/iframes.
  useEffect(() => {
    const onNative = (e: Event) => {
      const d = (e as CustomEvent<{ type?: string; muted?: boolean }>).detail;
      const e_ = callEngine;
      if (!d || !e_) return;
      const st = e_.snapshot();
      if (d.type === "call:hangup") void (st.ui === "incoming" ? e_.decline() : e_.hangup());
      else if (d.type === "call:accept" && st.ui === "incoming") void e_.accept(st.call?.video ?? false);
      else if (d.type === "call:decline" && st.ui === "incoming") void e_.decline();
      else if (d.type === "call:mute" && typeof d.muted === "boolean" && d.muted !== st.muted) void e_.toggleMute();
    };
    window.addEventListener("openlounge:native-call", onNative);
    return () => window.removeEventListener("openlounge:native-call", onNative);
  }, []);

  return (
    <>
      {children}
      {s.ui && <CallOverlay />}
    </>
  );
}

/** Start a call from anywhere (DM header, call history, missed-call "Call back"). */
export function startCall(peer: { id: string; name: string; color: string; photoUrl: string | null; username?: string }, video = false) {
  return callEngine?.start(peer, video);
}
