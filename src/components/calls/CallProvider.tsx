"use client";

// Mounts the call engine for the whole app: binds it to the socket + signed-in user, resumes a live call after a
// reconnect / reload, and renders the call screen (or the minimized green bar) above every page.
import { useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { useApp } from "@/components/AppProvider";
import { callEngine } from "@/lib/calls/engine";
import { installAudioUnlock } from "@/lib/audioUnlock";
import { installAppLockPresence } from "@/lib/calls/appLockPresence";
import { needsBackgroundRing, startBackgroundRing, stopBackgroundRing } from "@/lib/calls/backgroundRing";
import { appVisible, NATIVE_LOCK_EVENT, NATIVE_VISIBILITY_EVENT } from "@/lib/realtime";
import { native } from "@/lib/native";
import { checkMediaPermissionsSilently } from "@/lib/calls/permissions";
import { useCall } from "./useCall";
import css from "./calls.module.css";

// the call UI (and livekit-client inside the engine's dynamic import) only loads when a call exists
const CallOverlay = dynamic(() => import("./CallOverlay").then((m) => m.CallOverlay), { ssr: false });

/** Page → native (same transport as engine.postNative; kept here so we don't touch engine.ts / tones.ts). */
function postNativeCall(msg: Record<string, unknown>) {
  if (typeof window === "undefined" || !(window as unknown as { __olNativeCalls?: unknown }).__olNativeCalls) return;
  const s = JSON.stringify(msg);
  try {
    const rn = (window as unknown as { ReactNativeWebView?: { postMessage(s: string): void } }).ReactNativeWebView;
    if (rn) rn.postMessage(s);
    else native()?.postMessage?.(s);
  } catch {
    /* ignore */
  }
}

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { socket, connected, me, toast } = useApp();
  const s = useCall();
  const meId = me?.id ?? null;
  const lastIncomingNative = useRef<string | null>(null);
  // Only the server-granted caller-native-video path needs a transparent WebView. Voice, Android, web, minimized,
  // and camera-off calls retain their existing page/compositor behavior.
  const nativeFullscreen = s.nativeVideo && !s.minimized && (s.ui === "connecting" || s.ui === "active") && (s.remoteCam || s.camOn);

  useEffect(() => {
    callEngine?.bind(socket, meId);
  }, [socket, meId]);

  // unlock the shared AudioContext on the first tap anywhere (and after iOS interruptions) so an incoming call's
  // ringtone can play even though it arrives over the WebSocket, outside any gesture
  useEffect(() => installAudioUnlock(), []);
  useEffect(() => installAppLockPresence(), []);
  // every launch: silent camera/mic status (permissions.query, never prompts); the prompt stays at call start
  useEffect(() => void checkMediaPermissionsSilently().catch(() => {}), []);

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
      // Native wrappers (CallKit / Android call screen) reload or re-navigate the WebView on unlock / lock-screen
      // answer; the call itself lives on natively and the server's reconnect grace rejoins the new page. A hangup here
      // dropped answered calls ~10 s after the callee unlocked. Real hangups come from the native end action.
      if ((window as unknown as { __olNativeCalls?: unknown }).__olNativeCalls) return;
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
    // Native Accept on an already-loaded page (CallKit / Android call screen): accept IN PLACE instead of the wrapper
    // reloading /call/<id>?accept=1 — the reload re-booted the whole app (auth, socket, media libs) and cost ~7 s of
    // accept→audio on push-woken calls. Returns false when this page can't take it, so the wrapper navigates as before.
    const w = window as unknown as { __olAcceptCall?: (id: string) => boolean };
    w.__olAcceptCall = (callId: string) => {
      const e_ = callEngine;
      if (!e_ || typeof callId !== "string" || !callId) return false;
      const st = e_.snapshot();
      if (st.call?.id === callId) {
        if (st.ui === "incoming") void e_.accept(st.call.video ?? false);
        return st.ui === "incoming" || st.ui === "connecting" || st.ui === "active";
      }
      if (!socket) return false;
      // cold page still connecting (lock-screen answer right after unlock): queue the accept for the socket instead of
      // letting the wrapper reload the page mid-answer
      if (!socket.connected) {
        const onConnect = () => {
          socket.off("connect", onConnect);
          void e_.openFromLink(callId, true);
        };
        socket.on("connect", onConnect);
        return true;
      }
      void e_.openFromLink(callId, true);
      return true;
    };
    return () => {
      window.removeEventListener("openlounge:native-call", onNative);
      if (w.__olAcceptCall) delete w.__olAcceptCall;
    };
  }, [socket]);

  // Service-worker Accept / Decline (background ring notification)
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data || {};
      const e_ = callEngine;
      if (!e_) return;
      const st = e_.snapshot();
      if (d.type === "openlounge:call-accept" && st.ui === "incoming" && (!d.callId || d.callId === st.call?.id)) {
        void e_.accept(st.call?.video ?? false);
      } else if (d.type === "openlounge:call-decline" && st.ui === "incoming" && (!d.callId || d.callId === st.call?.id)) {
        void e_.decline();
      }
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, []);

  // Background / App Lock: SW insistent notification + audio keepalive; hand off to native ring UI.
  useEffect(() => {
    const sync = () => {
      if (s.ui === "incoming" && s.call) {
        const info = {
          callId: s.call.id,
          name: s.call.caller?.name || "Incoming call",
          video: !!s.call.video,
          expiresAt: s.call.expiresAt || Date.now() + 45_000,
        };
        if (needsBackgroundRing()) startBackgroundRing(info);
        else stopBackgroundRing(s.call.id);
        // While App Lock / backgrounded, ask the native shell to surface IncomingCallActivity / CallKit
        // even if the FCM/VoIP push is still in flight (WS often wins the race).
        if (!appVisible() && lastIncomingNative.current !== s.call.id) {
          lastIncomingNative.current = s.call.id;
          postNativeCall({
            type: "call:incoming",
            callId: s.call.id,
            name: s.call.caller?.name || "",
            photo: s.call.caller?.photoUrl || "",
            video: !!s.call.video,
            expiresAt: s.call.expiresAt || Date.now() + 45_000,
          });
        }
      } else {
        stopBackgroundRing(s.call?.id);
        if (s.ui !== "incoming") lastIncomingNative.current = null;
      }
    };
    sync();
    window.addEventListener("visibilitychange", sync);
    window.addEventListener(NATIVE_VISIBILITY_EVENT, sync);
    window.addEventListener(NATIVE_LOCK_EVENT, sync);
    return () => {
      window.removeEventListener("visibilitychange", sync);
      window.removeEventListener(NATIVE_VISIBILITY_EVENT, sync);
      window.removeEventListener(NATIVE_LOCK_EVENT, sync);
    };
  }, [s.ui, s.call?.id, s.call?.expiresAt, s.call?.video, s.call?.caller?.name, s.call?.caller?.photoUrl]);

  return (
    <>
      <div className={nativeFullscreen ? css.nativeVideoUnderlay : undefined} aria-hidden={nativeFullscreen || undefined}>{children}</div>
      {s.ui && <CallOverlay />}
    </>
  );
}

/** Start a call from anywhere (DM header, call history, missed-call "Call back"). */
export function startCall(peer: { id: string; name: string; color: string; photoUrl: string | null; username?: string }, video = false) {
  return callEngine?.start(peer, video);
}
