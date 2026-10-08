"use client";

// Drop-in room audio via LiveKit (Cloud or self-hosted SFU).
//
// - Everyone in an Open Lounge room joins the matching LiveKit room as a subscriber.
// - Speakers/hosts get publish permission (token at join; updated server-side on promotion).
// - Mute state comes from our server (so host-mutes apply) and drives the local mic.
//   As soon as you're on stage the mic track is PUBLISHED (muted if you're muted), so
//   unmuting is instant and actually sends audio; muting mutes the LiveKit track itself.
// - Speaking indicators + audio levels for humans come from LiveKit (ActiveSpeakers + audioLevel).
// If the server has no LiveKit credentials, `status` is "unavailable" and the UI says so.

import { meterHz } from "@/lib/device";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalAudioTrack, Participant as LkParticipant, RemoteTrack, Room } from "livekit-client";

// livekit-client (~half of the room route's JS) is loaded only when a room actually connects audio,
// in parallel with the token request — not on hallway/DM/profile, and not on the room page's first paint.
type LiveKit = typeof import("livekit-client");
let lk: LiveKit | null = null;
const loadLiveKit = () => (lk ? Promise.resolve(lk) : import("livekit-client").then((m) => (lk = m)));
/** Fetch + compile the LiveKit client ahead of time (a joinable room card is on screen / Join is pressed). */
export function prewarmLiveKit() {
  if (typeof window === "undefined" || lk) return;
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  const go = () => void loadLiveKit().catch(() => {});
  if (idle) idle(go, { timeout: 1500 });
  else setTimeout(go, 200);
}

/** Connect-time marks (performance.measure) for the join → audio path; read in tests / devtools. */
export const markAudio = (name: string) => {
  try {
    performance.mark(`ol:${name}`);
  } catch {
    /* old WebView */
  }
};
import { authFetch } from "@/lib/auth";
import { setActiveAudioRoom, unlockAudio } from "@/lib/audioUnlock";

const MIC_OPTIONS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

export type AudioStatus = "off" | "connecting" | "connected" | "unavailable" | "error";

export function useLiveKitAudio({
  roomId,
  enabled,
  joined,
  isSpeaker,
  muted,
  prefetched,
}: {
  roomId: string;
  /** LiveKit url + token that came with the room:join ack (skips one HTTP round trip); used once */
  prefetched?: { url: string; token: string } | null;
  /** server says LiveKit is configured */
  enabled: boolean;
  /** we have a seat in the room */
  joined: boolean;
  isSpeaker: boolean;
  muted: boolean;
}) {
  const roomRef = useRef<Room | null>(null);
  const [status, setStatus] = useState<AudioStatus>("off");
  const [error, setError] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());
  /** 0–1 audio level per user id (local + remotes when LiveKit is connected) */
  const [levels, setLevels] = useState<Map<string, number>>(new Map());
  const [needsGesture, setNeedsGesture] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [localLevel, setLocalLevel] = useState(0);
  const [permVersion, setPermVersion] = useState(0);
  /** latest wanted mic state; applied serially so rapid taps can't double-publish */
  const want = useRef({ isSpeaker, muted });
  want.current = { isSpeaker, muted };
  const micChain = useRef<Promise<void>>(Promise.resolve());
  const prefetchedRef = useRef(prefetched ?? null);
  if (prefetched && prefetchedRef.current?.token !== prefetched.token) prefetchedRef.current = prefetched;

  // connect / disconnect
  useEffect(() => {
    if (!joined) return;
    if (!enabled) {
      setStatus("unavailable");
      return;
    }
    let cancelled = false;
    let room: Room | null = null;
    const attached = new Map<string, HTMLMediaElement[]>();
    const setup = (LK: LiveKit) => {
    const { RoomEvent, Track } = LK;
    const r = new LK.Room({ adaptiveStream: true, dynacast: true });
    room = r;
    roomRef.current = r;
    r
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.dataset.lkAudio = "1";
        el.setAttribute("playsinline", "true"); // iOS WKWebView: never go fullscreen / pause
        el.autoplay = true;
        document.body.appendChild(el);
        attached.set(track.sid ?? String(Math.random()), [el]);
        setNeedsGesture(!r.canPlaybackAudio);
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach((el) => el.remove());
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: LkParticipant[]) => {
        setSpeaking(new Set(speakers.map((s) => s.identity)));
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => setNeedsGesture(!r.canPlaybackAudio))
      .on(RoomEvent.ParticipantPermissionsChanged, () => setPermVersion((v) => v + 1))
      .on(RoomEvent.Reconnecting, () => setStatus("connecting"))
      .on(RoomEvent.Reconnected, () => setStatus("connected"))
      .on(RoomEvent.Disconnected, () => !cancelled && setStatus("off"));
    return r;
    };

    (async () => {
      setStatus("connecting");
      setError(null);
      try {
        markAudio("audio-start");
        const lkLoad = loadLiveKit();
        // token from the join ack (one-shot) → no extra round trip; otherwise (reconnects) the HTTP endpoint,
        // access token attached; a 401 refreshes silently and retries once
        const pre = prefetchedRef.current;
        prefetchedRef.current = null;
        let body: { ok: boolean; url?: string; token?: string; error?: string; configured?: boolean };
        if (pre?.token && pre.url) body = { ok: true, url: pre.url, token: pre.token };
        else {
          const res = await authFetch("/api/livekit/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ roomId }),
          });
          body = ((await res.json().catch(() => null)) ?? { ok: false }) as typeof body;
          if (cancelled) return;
          if (res.status === 503 || body.configured === false) {
            setStatus("unavailable");
            return;
          }
        }
        markAudio("audio-token");
        if (!body.ok || !body.url || !body.token) throw new Error("audio token");
        const LK = await lkLoad;
        if (cancelled) return;
        const room = setup(LK);
        // Railway has no inbound UDP — self-hosted LiveKit is force_tcp. Prefer TCP ICE
        // candidates and give signalling/ICE more time so a slow proxy doesn't fail the room.
        await room.connect(body.url, body.token, {
          autoSubscribe: true,
          peerConnectionTimeout: 20_000,
          rtcConfig: {
            iceTransportPolicy: "all",
          },
        });
        if (cancelled) return room.disconnect();
        setActiveAudioRoom(room);
        markAudio("audio-connected");
        setStatus("connected");
        // try to start playback right away (works if the user already tapped); else show the banner
        await room.startAudio().catch(() => {});
        setNeedsGesture(!room.canPlaybackAudio);
      } catch (err) {
        // Soft-fail: the in-app room already exists; only audio is down.
        if (cancelled) return;
        console.warn("[audio] LiveKit connect failed", err);
        setError("Live audio couldn't connect");
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      setActiveAudioRoom(null);
      const r = room as Room | null;
      r?.removeAllListeners();
      void r?.disconnect();
      document.querySelectorAll("[data-lk-audio]").forEach((el) => el.remove());
      roomRef.current = null;
      setSpeaking(new Set());
      setLevels(new Map());
      setStatus("off");
    };
  }, [roomId, enabled, joined]);

  // mic follows server state: on stage => mic track published (muted or live); listener => unpublished
  useEffect(() => {
    const room = roomRef.current;
    if (!room || status !== "connected") return;
    const apply = async () => {
      if (roomRef.current !== room || room.state !== "connected") return;
      const { isSpeaker: speaker, muted: mute } = want.current;
      const lp = room.localParticipant;
      const { Track, createLocalAudioTrack } = lk!;
      let pub = lp.getTrackPublication(Track.Source.Microphone);
      if (!speaker) {
        if (pub?.track) await lp.unpublishTrack(pub.track, true); // releases the mic (OS indicator off)
        return;
      }
      if (!lp.permissions?.canPublish) return; // waiting for the server grant (re-runs on permVersion)
      if (!pub?.track) {
        // Publish now even when muted, so the track exists and unmute is instant.
        const track = await createLocalAudioTrack(MIC_OPTIONS);
        if (roomRef.current !== room || !want.current.isSpeaker) return track.stop();
        if (want.current.muted) await track.mute();
        await lp.publishTrack(track, { source: Track.Source.Microphone });
        pub = lp.getTrackPublication(Track.Source.Microphone);
      }
      const track = pub?.track as LocalAudioTrack | undefined;
      if (!track) return;
      const nowMuted = want.current.muted;
      if (nowMuted && !track.isMuted) await track.mute();
      else if (!nowMuted && track.isMuted) await track.unmute();
    };
    micChain.current = micChain.current
      .then(apply)
      .then(() => setMicError(null))
      .catch((err: Error) => {
        console.warn("[audio] mic", err);
        setMicError(/permission|denied|notallowed/i.test(err.message + err.name) ? "Microphone permission denied" : "Couldn't use the microphone. Tap to try again.");
      });
  }, [isSpeaker, muted, status, permVersion]);

  // Poll LiveKit audioLevel for glow intensity (local + remotes)
  useEffect(() => {
    if (status !== "connected") {
      setLocalLevel(0);
      setLevels(new Map());
      return;
    }
    // attack/release envelope so the speaking ring doesn't flicker on raw levels
    const env = new Map<string, number>();
    const smooth = (id: string, raw: number) => {
      const prev = env.get(id) ?? 0;
      const k = raw > prev ? 0.6 : 0.18; // fast attack, slow release
      let v = prev + (raw - prev) * k;
      if (v < 0.01) v = 0;
      env.set(id, v);
      return Math.round(v * 50) / 50;
    };
    let lastLocal = -1;
    let lastKey = "";
    const iv = setInterval(() => {
      const room = roomRef.current;
      if (!room) return;
      if (document.visibilityState !== "visible") return; // no metering/re-render while backgrounded
      const next = new Map<string, number>();
      const local = smooth(room.localParticipant.identity, room.localParticipant.audioLevel ?? 0);
      next.set(room.localParticipant.identity, local);
      const ll = isSpeaker && !muted ? Math.round(local * 20) / 20 : 0;
      if (ll !== lastLocal) setLocalLevel((lastLocal = ll));
      room.remoteParticipants.forEach((p) => {
        // muted (TrackMuted) => no level, so the speaking glow can't show
        next.set(p.identity, smooth(p.identity, p.isMicrophoneEnabled ? (p.audioLevel ?? 0) : 0));
      });
      // only re-render the room when a level actually changed (silence = zero renders)
      let key = "";
      next.forEach((v, k) => (key += k + ":" + v + ";"));
      if (key !== lastKey) {
        lastKey = key;
        setLevels(next);
      }
    }, Math.round(1000 / meterHz())); // ≤15 Hz (8 Hz on low-end devices)
    return () => clearInterval(iv);
  }, [status, isSpeaker, muted]);

  // Returning to foreground (app switch / WebView resume): AudioContext and playback may be suspended.
  useEffect(() => {
    if (status !== "connected") return;
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      const room = roomRef.current;
      if (!room) return;
      unlockAudio();
      void room.startAudio().catch(() => {}).then(() => setNeedsGesture(!room.canPlaybackAudio));
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", onVis);
    };
  }, [status]);

  const startAudio = useCallback(async () => {
    unlockAudio();
    const room = roomRef.current;
    await room?.startAudio().catch(() => {});
    setNeedsGesture(room ? !room.canPlaybackAudio : false);
  }, []);

  return { status, error, speaking, levels, needsGesture, startAudio, micError, localLevel };
}
