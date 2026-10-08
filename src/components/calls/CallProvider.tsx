"use client";

// Mounts the call engine for the whole app: binds it to the socket + signed-in user, resumes a live call after a
// reconnect / reload, and renders the call screen (or the minimized green bar) above every page.
import { useEffect } from "react";
import dynamic from "next/dynamic";
import { useApp } from "@/components/AppProvider";
import { callEngine } from "@/lib/calls/engine";
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
