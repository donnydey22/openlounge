"use client";

// Drop-in room audio via LiveKit (Cloud or self-hosted SFU).
//
// - Everyone in an Open Lounge room joins the matching LiveKit room as a subscriber.
// - Speakers/hosts get publish permission (token at join; updated server-side on promotion).
// - Mute state comes from our server (so host-mutes apply) and drives the local mic.
// - Speaking indicators + audio levels for humans come from LiveKit (ActiveSpeakers + audioLevel).
// If the server has no LiveKit credentials, `status` is "unavailable" and the UI says so.

import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, type Participant as LkParticipant, type RemoteTrack } from "livekit-client";
import { loadToken } from "@/lib/session";

export type AudioStatus = "off" | "connecting" | "connected" | "unavailable" | "error";

export function useLiveKitAudio({
  roomId,
  enabled,
  joined,
  isSpeaker,
  muted,
}: {
  roomId: string;
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

  // connect / disconnect
  useEffect(() => {
    if (!joined) return;
    if (!enabled) {
      setStatus("unavailable");
      return;
    }
    let cancelled = false;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;
    const attached = new Map<string, HTMLMediaElement[]>();

    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind !== Track.Kind.Audio) return;
        const el = track.attach();
        el.dataset.lkAudio = "1";
        document.body.appendChild(el);
        attached.set(track.sid ?? String(Math.random()), [el]);
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach((el) => el.remove());
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: LkParticipant[]) => {
        setSpeaking(new Set(speakers.map((s) => s.identity)));
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => setNeedsGesture(!room.canPlaybackAudio))
      .on(RoomEvent.ParticipantPermissionsChanged, () => setPermVersion((v) => v + 1))
      .on(RoomEvent.Reconnecting, () => setStatus("connecting"))
      .on(RoomEvent.Reconnected, () => setStatus("connected"))
      .on(RoomEvent.Disconnected, () => !cancelled && setStatus("off"));

    (async () => {
      setStatus("connecting");
      setError(null);
      try {
        const res = await fetch("/api/livekit/token", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${loadToken() ?? ""}` },
          body: JSON.stringify({ roomId }),
        });
        const body = (await res.json()) as { ok: boolean; url?: string; token?: string; error?: string; configured?: boolean };
        if (cancelled) return;
        if (res.status === 503 || body.configured === false) {
          setStatus("unavailable");
          return;
        }
        if (!body.ok || !body.url || !body.token) throw new Error(body.error || "Couldn't get an audio token");
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
        setStatus("connected");
        setNeedsGesture(!room.canPlaybackAudio);
      } catch (err) {
        // Soft-fail: the in-app room already exists; only audio is down.
        if (cancelled) return;
        console.warn("[audio] LiveKit connect failed", err);
        const msg = (err as Error)?.message || "Live audio couldn't connect";
        setError(msg.length > 120 ? "Live audio couldn't connect" : msg);
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      room.removeAllListeners();
      room.disconnect();
      document.querySelectorAll("[data-lk-audio]").forEach((el) => el.remove());
      roomRef.current = null;
      setSpeaking(new Set());
      setLevels(new Map());
      setStatus("off");
    };
  }, [roomId, enabled, joined]);

  // mic follows server state: on stage + unmuted => publish/enable mic
  useEffect(() => {
    const room = roomRef.current;
    if (!room || status !== "connected") return;
    const want = isSpeaker && !muted;
    const lp = room.localParticipant;
    if (want && !lp.permissions?.canPublish) return; // waiting for the server to grant publish (re-runs on permVersion)
    lp.setMicrophoneEnabled(want, { echoCancellation: true, noiseSuppression: true, autoGainControl: true })
      .then(() => setMicError(null))
      .catch((err: Error) => {
        console.warn("[audio] mic", err);
        setMicError(/permission|denied|notallowed/i.test(err.message + err.name) ? "Microphone permission denied" : err.message);
      });
  }, [isSpeaker, muted, status, permVersion]);

  // Poll LiveKit audioLevel for glow intensity (local + remotes)
  useEffect(() => {
    if (status !== "connected") {
      setLocalLevel(0);
      setLevels(new Map());
      return;
    }
    const iv = setInterval(() => {
      const room = roomRef.current;
      if (!room) return;
      const next = new Map<string, number>();
      const local = room.localParticipant.audioLevel ?? 0;
      next.set(room.localParticipant.identity, local);
      setLocalLevel(isSpeaker && !muted ? Math.round(local * 20) / 20 : 0);
      room.remoteParticipants.forEach((p) => {
        next.set(p.identity, p.audioLevel ?? 0);
      });
      setLevels(next);
    }, 80);
    return () => clearInterval(iv);
  }, [status, isSpeaker, muted]);

  const startAudio = useCallback(async () => {
    await roomRef.current?.startAudio();
    setNeedsGesture(false);
  }, []);

  return { status, error, speaking, levels, needsGesture, startAudio, micError, localLevel };
}
