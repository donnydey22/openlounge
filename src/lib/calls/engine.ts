// Client call engine: one per app. Owns the call state machine on this device, the LiveKit connection, local
// mic/camera tracks, remote media, sounds and timing. React reads it through useSyncExternalStore (useCall).
//
// Speed (accept → first audio): both LiveKit tokens are minted at ring time; while it rings the callee's device
// loads the LiveKit client, pre-opens the signalling connection (prepareConnection) and, if mic permission is
// already granted, pre-acquires the mic. Accepting then just connects + publishes. The caller is already in the
// LiveKit room publishing when the callee joins, so audio flows the moment the callee's transport is up.
import type { CallInfo, CallMedia, CallOutcome } from "@/lib/types";
import type { RealtimeClient } from "@/lib/realtime";
import type { LocalAudioTrack, LocalVideoTrack, RemoteTrack, Room } from "livekit-client";
import { native, nativePlatform } from "@/lib/native";
import { browserNetworkTier, captureResolution, currentCodecChoice, micPublishOptions, publishCamera, publishDefaults } from "./videoPolicy";
import { audioContext, unlockAudio } from "@/lib/audioUnlock";
import { enableVoiceProcessing, type VoiceProcessingHandle } from "./voiceProcessing";
import { playBusy, playConnected, playHangup, playRingback, playRingtone, ringing, stopTones } from "./tones";
import { livekitRtcConfig } from "@/lib/livekitIce";
import { MediasoupCallSession, type MediasoupRemoteTrack } from "./mediasoupSession";

type LK = typeof import("livekit-client");
let lk: LK | null = null;
const loadLK = () => (lk ? Promise.resolve(lk) : import("livekit-client").then((m) => (lk = m)));

export type CallUi = "incoming" | "outgoing" | "connecting" | "active" | "ended";
export type Quality = "excellent" | "good" | "poor" | "lost" | "unknown";

export interface CallSnapshot {
  call: CallInfo | null;
  role: "caller" | "callee" | null;
  ui: CallUi | null;
  minimized: boolean;
  muted: boolean;
  camOn: boolean;
  facing: "user" | "environment";
  remoteCam: boolean;
  remoteMuted: boolean;
  speaker: boolean;
  speakerSupported: boolean;
  quality: Quality;
  reconnecting: boolean;
  /** the other person lost their connection (server call:peer / LiveKit): "Bea is reconnecting…" */
  peerReconnecting: boolean;
  connectedAt: number | null;
  endedText: string | null;
  /** ended because of busy / no answer → offer "Call again" */
  canRetry: boolean;
  error: string | null;
  needsGesture: boolean;
  /** "Bea turned on video" prompt (offer to turn on mine) */
  videoInvite: boolean;
  v: number;
}

const MIC = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const ENDED_LINGER_MS = 1800;

const initial = (): CallSnapshot => ({
  call: null,
  role: null,
  ui: null,
  minimized: false,
  muted: false,
  camOn: false,
  facing: "user",
  remoteCam: false,
  remoteMuted: false,
  speaker: false,
  speakerSupported: false,
  quality: "unknown",
  reconnecting: false,
  peerReconnecting: false,
  connectedAt: null,
  endedText: null,
  canRetry: false,
  error: null,
  needsGesture: false,
  videoInvite: false,
  v: 0,
});

const mark = (n: string) => {
  try {
    performance.mark(`ol:call-${n}`);
  } catch {
    /* old WebView */
  }
};

/** Native wrappers (build 18 / 0.3.1) opt in with window.__olNativeCalls = 1; older apps never get these messages. */
function postNative(msg: Record<string, unknown>) {
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

function buzz(kind: "light" | "medium" | "success" | "warning") {
  try {
    const n = native();
    if (n?.haptic) return n.haptic(kind);
    if ("vibrate" in navigator) navigator.vibrate(kind === "light" ? 10 : kind === "warning" ? [30, 40, 30] : 20);
  } catch {
    /* ignore */
  }
}

export class CallEngine {
  private s: CallSnapshot = initial();
  private listeners = new Set<() => void>();
  private socket: RealtimeClient | null = null;
  private meId: string | null = null;
  private media: CallMedia | null = null;
  private room: Room | null = null;
  private roomPromise: Promise<Room | MediasoupCallSession | null> | null = null;
  private mediasoup: MediasoupCallSession | null = null;
  private mediasoupConnected = false;
  private mediasoupLocalVideo: MediaStreamTrack | null = null;
  private mediasoupRemoteVideo: MediaStreamTrack | null = null;
  private mediasoupDegradeTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackInFlight = false;
  private micTrack: LocalAudioTrack | null = null;
  private preMic: Promise<LocalAudioTrack | null> | null = null;
  private micVoiceProcessing: VoiceProcessingHandle | null = null;
  private camTrack: LocalVideoTrack | null = null;
  private remoteVideo: RemoteTrack | null = null;
  private audioEls: HTMLMediaElement[] = [];
  private videoEls = { local: null as HTMLVideoElement | null, remote: null as HTMLVideoElement | null };
  private acceptedHere = false;
  private acceptT0 = 0;
  private metricSent = false;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private weakTimer: ReturnType<typeof setTimeout> | null = null;
  private sinkIds: string[] = [];
  private lastPeer: { id: string; video: boolean } | null = null;

  // ---------- store plumbing ----------
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  snapshot = () => this.s;
  private set(patch: Partial<CallSnapshot>) {
    const was = this.s.reconnecting;
    this.s = { ...this.s, ...patch, v: this.s.v + 1 };
    if (this.s.reconnecting !== was) this.armStuckGuard();
    for (const l of this.listeners) l();
  }
  private stuckTimer: ReturnType<typeof setTimeout> | null = null;
  /** LiveKit's resume can wedge (seen in Firefox after a long silent loss: "reconnecting" forever, no Disconnected).
   *  Still reconnecting 20 s later while the network is up → do our own full rejoin with a fresh token. */
  private armStuckGuard() {
    if (this.stuckTimer) clearTimeout(this.stuckTimer);
    this.stuckTimer = null;
    if (!this.s.reconnecting) return;
    this.stuckTimer = setTimeout(() => {
      this.stuckTimer = null;
      if (!this.s.reconnecting || !this.busy || this.rejoining || this.s.ui !== "active") return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return void this.armStuckGuard();
      this.netLog("stuck-rejoin");
      void this.rejoin("stuck");
    }, CallEngine.STUCK_MS);
  }
  static STUCK_MS = 20_000;
  get busy() {
    return this.s.ui !== null && this.s.ui !== "ended";
  }

  // ---------- socket ----------
  bind(socket: RealtimeClient | null, meId: string | null) {
    this.meId = meId;
    if (this.socket === socket) return;
    if (this.socket) {
      this.socket.off("call:incoming", this.onIncoming);
      this.socket.off("call:state", this.onState);
      this.socket.off("call:video", this.onVideo);
      this.socket.off("call:peer", this.onPeer);
      this.socket.off("call:mediaFallback", this.onMediaFallback);
    }
    this.socket = socket;
    if (!socket) return;
    socket.on("call:incoming", this.onIncoming);
    socket.on("call:state", this.onState);
    socket.on("call:video", this.onVideo);
    socket.on("call:peer", this.onPeer);
    socket.on("call:mediaFallback", this.onMediaFallback);
    this.watchNetwork();
  }

  private req<T = Record<string, unknown>>(ev: string, data: unknown, ms = 10_000): Promise<T> {
    if (!this.socket) return Promise.reject(new Error("Not connected"));
    return this.socket.request<T>(ev, data, ms);
  }

  /** after (re)connect + auth: pick up a call that is still live (page reload, network switch) */
  async resume() {
    try {
      const r = await this.req<{ ok: boolean; call?: CallInfo | null }>("call:current", {});
      const call = r.call;
      if (!call) {
        // our call ended while we were offline (e.g. the 45 s grace ran out): say so instead of vanishing
        if (this.s.call && this.busy) this.finishLocal(this.s.call.outcome ?? "completed", this.s.ui === "incoming", this.s.call, this.s.ui === "active" || this.s.reconnecting ? "connection_lost" : undefined);
        return;
      }
      if (this.s.call?.id === call.id && (this.room || this.mediasoup)) {
        // WS came back while media kept going (or LiveKit is resuming): just re-sync the peer's state
        this.set({ peerReconnecting: !!call.offline?.some((u) => u !== this.meId) });
        return;
      }
      if (this.s.call?.id === call.id && call.phase === "active" && this.s.connectedAt) {
        this.wake?.();
        if (!this.rejoining) void this.rejoin("ws-resume");
        return;
      }
      const g = await this.req<{ ok: boolean; call?: CallInfo; media?: CallMedia | null }>("call:get", { callId: call.id });
      if (!g.ok || !g.call) return;
      const role = g.call.callerId === this.meId ? "caller" : "callee";
      if (g.call.phase === "active" && (role === "caller" || this.acceptedHere || this.s.call?.id === call.id)) {
        this.media = g.media ?? null;
        this.set({ call: g.call, role, ui: "connecting", connectedAt: this.s.connectedAt ?? Date.now() });
        await this.connect(true);
      } else if (role === "callee" && g.call.phase !== "active" && g.call.phase !== "ended") {
        this.onIncoming({ call: g.call, media: g.media ?? null });
      } else if (role === "caller" && (g.call.phase === "calling" || g.call.phase === "ringing")) {
        this.media = g.media ?? null;
        this.set({ call: g.call, role, ui: "outgoing" });
        await this.connect(false);
      }
    } catch {
      /* offline: next reconnect retries */
    }
  }

  /** /call/<id>[?accept=1] (push tap / native Accept): ring or join that call. Returns the other person's id. */
  async openFromLink(callId: string, accept: boolean): Promise<{ peerId: string | null; ended: boolean }> {
    try {
      const g = await this.req<{ ok: boolean; call?: CallInfo; media?: CallMedia | null }>("call:get", { callId });
      if (!g.ok || !g.call) return { peerId: null, ended: true };
      const c = g.call;
      const peerId = c.callerId === this.meId ? c.calleeId : c.callerId;
      if (c.phase === "ended") return { peerId, ended: true };
      if (c.calleeId === this.meId && c.phase !== "active") {
        if (this.s.call?.id !== c.id) this.onIncoming({ call: c, media: g.media ?? null });
        if (accept) await this.accept(c.video);
      } else await this.resume();
      return { peerId, ended: false };
    } catch {
      return { peerId: null, ended: true };
    }
  }

  // ---------- outgoing ----------
  async start(peer: { id: string; name: string; color: string; photoUrl: string | null; username?: string }, video: boolean) {
    if (this.busy) return { ok: false, error: "You're already in a call" };
    unlockAudio();
    buzz("light");
    this.clearEnd();
    this.lastPeer = { id: peer.id, video };
    const now = Date.now();
    const optimistic: CallInfo = {
      id: "",
      callerId: this.meId ?? "",
      calleeId: peer.id,
      video,
      phase: "calling",
      createdAt: now,
      answeredAt: null,
      endedAt: null,
      outcome: null,
      expiresAt: now + 45_000,
      caller: { id: this.meId ?? "", name: "You", color: "#10B981", photoUrl: null },
      callee: { id: peer.id, name: peer.name, color: peer.color, photoUrl: peer.photoUrl, username: peer.username },
    };
    this.set({ ...initial(), call: optimistic, role: "caller", ui: "outgoing", camOn: video, v: this.s.v + 1 });
    // ringback from the tap (audio and video alike) until connect / end — not only after the callee's device acks
    playRingback({ video, untilMs: optimistic.expiresAt + 2000 });
    void loadLK().catch(() => {});
    // mic (and camera) permission prompt happens now, inside the tap, in parallel with the server round trip
    this.preMic = this.acquireMic();
    if (video) void this.ensureCamPreview();
    let r: { ok: boolean; call?: CallInfo; media?: CallMedia | null; error?: string; reason?: string };
    try {
      r = await this.req("call:start", { peerId: peer.id, video });
    } catch {
      r = { ok: false, error: "No connection. Try again." };
    }
    if (!r.ok || !r.call) {
      if (r.reason === "busy") {
        playBusy();
        this.endWith(r.call ?? optimistic, `${peer.name.split(" ")[0]} is on another call`, true);
      } else {
        this.teardownMedia();
        this.set({ ...initial(), error: r.error ?? "Couldn't start the call", v: this.s.v + 1 });
      }
      return { ok: false, error: r.error };
    }
    if (this.s.ui !== "outgoing") return { ok: true }; // hung up while the request was in flight
    if (ringing() !== "outgoing") playRingback({ video, untilMs: r.call.expiresAt + 2000 });
    this.media = r.media ?? null;
    this.set({ call: r.call });
    if (!this.media) {
      this.set({ error: "Calls aren't available right now" });
      void this.hangup();
      return { ok: false };
    }
    postNative({ type: "call:outgoing", callId: r.call.id, name: peer.name, video });
    void this.connect(false);
    return { ok: true };
  }

  // ---------- incoming ----------
  private onIncoming = (d: { call: CallInfo; media: CallMedia | null }) => {
    const call = d?.call;
    if (!call || call.calleeId !== this.meId) return;
    if (this.s.call?.id === call.id && this.busy) return;
    if (this.busy) return; // server already treats us as busy; never stack ring screens
    this.clearEnd();
    this.media = d.media;
    this.acceptedHere = false;
    this.metricSent = false;
    this.set({ ...initial(), call, role: "callee", ui: "incoming", v: this.s.v + 1 });
    void this.req("call:ack", { callId: call.id }).catch(() => {});
    playRingtone({ video: call.video, untilMs: call.expiresAt + 2000 });
    mark("ring");
    // Pre-warm only the existing LiveKit path. The brokered Mediasoup path must wait for Accept so it does not create
    // a UDP transport before the user consents to answer.
    if (this.media?.provider === "livekit")
      void loadLK()
        .then((LK) => {
          if (!this.media || this.media.provider !== "livekit" || this.s.call?.id !== call.id) return;
          const room = this.newRoom(LK);
          this.room = room;
          void room.prepareConnection(this.media.url, this.media.token).catch(() => {});
        })
        .catch(() => {});
    if (this.media?.provider === "livekit")
      void micPermission().then((p) => {
        if (p === "granted" && this.s.call?.id === call.id && this.s.ui === "incoming") this.preMic = this.acquireMic();
      });
  };

  async accept(withVideo = false) {
    const call = this.s.call;
    if (!call || this.s.ui !== "incoming") return;
    unlockAudio();
    stopTones();
    buzz("medium");
    this.acceptT0 = performance.now();
    mark("accept");
    this.acceptedHere = true;
    this.set({ ui: "connecting", camOn: withVideo });
    if (this.media?.provider === "livekit") {
      if (!this.preMic) this.preMic = this.acquireMic();
      if (withVideo) void this.ensureCamPreview();
    }
    // connect with the ring-time token right away, in parallel with telling the server
    const accepted = this.req<{ ok: boolean; call?: CallInfo; media?: CallMedia | null; error?: string }>("call:accept", { callId: call.id }).catch(() => ({ ok: false, error: "No connection" }) as const);
    if (!this.media) {
      const r = await accepted;
      if (!r.ok) return this.endWith(call, r.error === "Call ended" ? "Call ended" : (r.error ?? "Couldn't answer"), false);
      this.media = ("media" in r ? r.media : null) ?? null;
      if (!this.media) {
        this.set({ error: "Calls aren't available right now" });
        return void this.hangup();
      }
    }
    void this.connect(true);
    const r = await accepted;
    if (!r.ok) {
      this.teardownMedia();
      this.endWith(call, r.error === "Call ended" ? "Call ended" : (r.error ?? "Couldn't answer"), false);
    } else if (r.call) this.set({ call: r.call, connectedAt: this.s.connectedAt ?? Date.now() });
  }

  async decline(message?: string) {
    const call = this.s.call;
    if (!call) return;
    stopTones();
    buzz("light");
    void this.req("call:decline", { callId: call.id, ...(message ? { message } : {}) }).catch(() => {});
    this.teardownMedia();
    this.set({ ...initial(), v: this.s.v + 1 });
  }

  async hangup() {
    const call = this.s.call;
    if (!call) return;
    buzz("light");
    if (call.id) void this.req("call:hangup", { callId: call.id }).catch(() => {});
    const dur = this.s.connectedAt ? Math.round((Date.now() - this.s.connectedAt) / 1000) : 0;
    playHangup();
    postNative({ type: "call:ended", callId: call.id });
    this.teardownMedia();
    this.endWith(call, this.s.ui === "active" ? `Call ended · ${fmt(dur)}` : "Call cancelled", false);
  }

  // ---------- server state ----------
  private onState = (d: { call: CallInfo; by?: string | null }) => {
    const call = d?.call;
    if (!call || !this.s.call) return;
    if (this.s.call.id && this.s.call.id !== call.id) return;
    if (!this.s.call.id && call.callerId !== this.meId) return;
    const role = this.s.role;
    if (call.phase === "ringing" && role === "caller" && this.s.ui === "outgoing") {
      this.set({ call });
      if (ringing() !== "outgoing") playRingback({ video: call.video, untilMs: call.expiresAt + 2000 }); // already ringing since the tap
      return;
    }
    if (call.phase === "active") {
      if (role === "callee" && !this.acceptedHere) {
        // answered on another device
        stopTones();
        this.teardownMedia();
        this.set({ ...initial(), v: this.s.v + 1 });
        return;
      }
      if (role === "caller" && this.s.ui === "outgoing") {
        stopTones();
        this.acceptT0 = performance.now();
        mark("accepted");
        this.set({ call, ui: this.mediaConnected() ? "active" : "connecting", connectedAt: Date.now() });
        if (this.mediaConnected()) playConnected();
        postNative({ type: "call:connected", callId: call.id });
      }
      return;
    }
    if (call.phase === "ended") this.finishLocal(call.outcome ?? "completed", false, call, (d as { reason?: string }).reason);
    else if (call.offline) this.set({ peerReconnecting: call.offline.some((u) => u !== this.meId) });
  };

  private finishLocal(outcome: CallOutcome, quiet: boolean, call: CallInfo | null = this.s.call, reason?: string) {
    if (!call || !this.busy) return;
    const role = this.s.role;
    const wasIncoming = this.s.ui === "incoming";
    stopTones();
    this.teardownMedia();
    postNative({ type: "call:ended", callId: call.id });
    if (wasIncoming || quiet) {
      this.set({ ...initial(), v: this.s.v + 1 });
      return;
    }
    const dur = this.s.connectedAt ? Math.round((Date.now() - this.s.connectedAt) / 1000) : 0;
    const name = (role === "caller" ? call.callee.name : call.caller.name).split(" ")[0];
    const lost = reason === "connection_lost" && outcome === "completed";
    const text =
      lost
        ? `Connection lost · ${fmt(dur)}`
        : outcome === "completed"
        ? `Call ended · ${fmt(dur)}`
        : outcome === "missed"
          ? "No answer"
          : outcome === "declined"
            ? `${name} declined`
            : outcome === "busy"
              ? `${name} is on another call`
              : outcome === "failed"
                ? "Call failed"
                : "Call ended";
    if (outcome === "completed") playHangup();
    else if (outcome !== "cancelled") playBusy();
    this.endWith(call, text, lost || (role === "caller" && (outcome === "missed" || outcome === "declined" || outcome === "busy")));
  }

  private endWith(call: CallInfo, text: string, canRetry: boolean) {
    this.clearEnd();
    this.teardownMedia();
    this.set({ call: { ...call, phase: "ended" }, ui: "ended", endedText: text, canRetry, minimized: false, reconnecting: false });
    this.endTimer = setTimeout(() => this.set({ ...initial(), v: this.s.v + 1 }), canRetry ? 6000 : ENDED_LINGER_MS);
  }
  private clearEnd() {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = null;
  }
  dismiss() {
    this.clearEnd();
    this.set({ ...initial(), v: this.s.v + 1 });
  }
  retry() {
    const c = this.s.call;
    if (!c) return;
    const peer = c.callerId === this.meId ? c.callee : c.caller;
    this.dismiss();
    void this.start(peer, this.lastPeer?.video ?? c.video);
  }

  private onVideo = (d: { callId: string; from: string; on: boolean }) => {
    if (!this.s.call || d?.callId !== this.s.call.id) return;
    if (d.on && !this.s.camOn) this.set({ videoInvite: true });
    if (!d.on) this.set({ videoInvite: false });
  };

  // ---------- media ----------
  private newRoom(LK: LK) {
    return new LK.Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: MIC,
      videoCaptureDefaults: { resolution: captureResolution(browserNetworkTier()), facingMode: "user" },
      // videoPolicy: Opus speech + DTX + RED at high priority; H.264 on capable phones (VP8 backup) else VP8;
      // simulcast q 180p/15fps/150k, h 360p/24fps/400k, f 1.2M/30fps
      publishDefaults: publishDefaults(LK, currentCodecChoice(nativePlatform()), browserNetworkTier()),
    });
  }

  private async acquireMic(): Promise<LocalAudioTrack | null> {
    try {
      const LK = await loadLK();
      const t = await LK.createLocalAudioTrack(MIC);
      if (!this.busy) {
        t.stop();
        return null;
      }
      // Browser AGC lifts ordinary speech; this final bounded gain + compressor improves quiet microphones without
      // clipping peaks. A suspended Web Audio destination is silent on iOS 15 / older Android WebViews, so attach it
      // only while the gesture-unlocked context is running (raw mic before that and during interruptions, swapped in place).
      this.clearMicVoiceProcessing();
      const context = audioContext();
      try {
        this.micVoiceProcessing = await enableVoiceProcessing(t, context);
        if (!this.micVoiceProcessing) this.netLog("mic-headroom-bypassed");
        else if (!this.micVoiceProcessing.processing) this.netLog("mic-headroom-deferred");
      } catch {
        this.netLog("mic-headroom-unavailable");
      }
      return t;
    } catch (e) {
      const msg = String((e as Error)?.name ?? "") + String((e as Error)?.message ?? "");
      this.set({ error: /NotAllowed|denied|Permission/i.test(msg) ? "Allow microphone access to make calls" : "Couldn't use the microphone" });
      return null;
    }
  }

  private async ensureCamPreview() {
    if (this.camTrack) return this.camTrack;
    try {
      const LK = await loadLK();
      const t = await LK.createLocalVideoTrack({ facingMode: this.s.facing, resolution: captureResolution(browserNetworkTier()) });
      if (!this.busy) {
        t.stop();
        return null;
      }
      this.camTrack = t;
      if (this.videoEls.local) t.attach(this.videoEls.local);
      this.set({ camOn: true });
      return t;
    } catch {
      this.set({ camOn: false, error: "Camera unavailable. Continuing with audio." });
      return null;
    }
  }

  private mediaConnected() {
    return this.room?.state === "connected" || this.mediasoupConnected;
  }

  /** Join the selected backend. LiveKit remains byte-for-byte the normal path unless CALL_SFU=layered selects UDP. */
  private connect(answer: boolean): Promise<Room | MediasoupCallSession | null> {
    if (this.roomPromise) return this.roomPromise;
    const media = this.media;
    if (!media) return Promise.resolve(null);
    if (media.provider === "mediasoup") {
      this.roomPromise = this.connectMediasoup(media, answer);
      return this.roomPromise;
    }
    this.roomPromise = (async () => {
      try {
        const LK = await loadLK();
        const room = this.room ?? this.newRoom(LK);
        this.room = room;
        this.wire(LK, room);
        mark("lk-connect");
        await room.connect(media.url, media.token, { autoSubscribe: true, peerConnectionTimeout: 20_000, rtcConfig: livekitRtcConfig(media.iceServers) });
        if (this.room !== room || !this.busy) {
          void room.disconnect();
          return null;
        }
        mark("lk-connected");
        const mic = (await this.preMic) ?? (await this.acquireMic());
        if (mic && this.room === room) {
          // If the context was interrupted while we connected, wait for LiveKit to restore the original mic track
          // before publication rather than sending a silent Web Audio destination.
          await this.micVoiceProcessing?.publishRawIfNeeded();
          this.micTrack = mic;
          if (this.s.muted) await mic.mute();
          await room.localParticipant.publishTrack(mic, { ...micPublishOptions(), source: LK.Track.Source.Microphone });
        }
        if (this.s.camOn) {
          const cam = await this.ensureCamPreview();
          if (cam && this.room === room) await publishCamera(LK, room, cam, currentCodecChoice(nativePlatform()), browserNetworkTier());
        }
        // never block "connected" on playback unlock / device enumeration (WebKit can leave play() pending without a gesture)
        void Promise.race([room.startAudio(), new Promise((r) => setTimeout(r, 1500))])
          .catch(() => {})
          .then(() => this.room === room && this.set({ needsGesture: !room.canPlaybackAudio }));
        void this.detectSpeaker().then((speakerSupported) => this.room === room && this.set({ speakerSupported }));
        if (answer || this.s.call?.phase === "active") {
          if (this.s.ui === "connecting") {
            this.set({ ui: "active", connectedAt: this.s.connectedAt ?? Date.now() });
            playConnected();
            postNative({ type: "call:connected", callId: this.s.call?.id });
          }
        }
        return room;
      } catch (e) {
        console.warn("[call] media connect failed", e);
        // while rejoining, a failed attempt just means "try again" (the rejoin loop owns the retries / give-up)
        if (this.busy && !this.rejoining) {
          this.set({ error: "Couldn't connect the call" });
          void this.hangup();
        }
        return null;
      }
    })();
    return this.roomPromise;
  }

  private async connectMediasoup(media: CallMedia, answer: boolean): Promise<MediasoupCallSession | null> {
    try {
      // A caller may have pre-acquired LiveKit tracks before the backend selection response arrived. Release them so
      // iOS/Android never hold two microphone/camera captures while the UDP transport starts.
      this.releaseLiveKitPrewarm();
      const session = new MediasoupCallSession(this.socket!, media, {
        onRemoteTrack: (track) => this.onMediasoupTrack(track),
        onState: (state) => this.onMediasoupState(state),
        onLocalVideo: (track) => this.setMediasoupLocalVideo(track),
      });
      this.mediasoup = session;
      await session.connect(this.s.camOn);
      if (this.mediasoup !== session || !this.busy) {
        session.close();
        return null;
      }
      this.mediasoupConnected = true;
      this.clearMediasoupDegrade();
      if (answer || this.s.call?.phase === "active") {
        if (this.s.ui === "connecting") {
          this.set({ ui: "active", connectedAt: this.s.connectedAt ?? Date.now(), reconnecting: false });
          playConnected();
          postNative({ type: "call:connected", callId: this.s.call?.id });
        }
      }
      return session;
    } catch (e) {
      if (this.busy) {
        this.netLog("ms-connect-failed");
        await this.requestTcpFallback();
      }
      return null;
    }
  }

  private releaseLiveKitPrewarm() {
    const room = this.room;
    this.room = null;
    if (room) {
      room.removeAllListeners();
      void room.disconnect();
    }
    this.clearMicVoiceProcessing();
    void this.preMic?.then((track) => track?.stop());
    this.preMic = null;
    this.micTrack?.stop();
    this.micTrack = null;
    this.camTrack?.stop();
    this.camTrack = null;
  }

  private onMediasoupTrack({ kind, track, close }: MediasoupRemoteTrack) {
    if (kind === "audio") {
      const el = document.createElement("audio");
      el.dataset.olCallAudio = "1";
      el.autoplay = true;
      el.setAttribute("playsinline", "true");
      el.srcObject = new MediaStream([track]);
      document.body.appendChild(el);
      this.audioEls.push(el);
      const onPlay = () => this.firstAudio();
      el.addEventListener("playing", onPlay, { once: true });
      void el.play().catch(() => this.set({ needsGesture: true }));
      track.addEventListener("ended", () => {
        el.remove();
        close();
      }, { once: true });
      return;
    }
    this.mediasoupRemoteVideo = track;
    this.attachRawVideo(this.videoEls.remote, track);
    this.set({ remoteCam: true, videoInvite: !this.s.camOn });
    track.addEventListener("ended", () => {
      if (this.mediasoupRemoteVideo === track) {
        this.mediasoupRemoteVideo = null;
        this.set({ remoteCam: false, videoInvite: false });
      }
      close();
    }, { once: true });
  }

  private setMediasoupLocalVideo(track: MediaStreamTrack | null) {
    this.mediasoupLocalVideo = track;
    this.attachRawVideo(this.videoEls.local, track);
  }

  private attachRawVideo(el: HTMLVideoElement | null, track: MediaStreamTrack | null) {
    if (!el) return;
    el.srcObject = track ? new MediaStream([track]) : null;
    if (track) void el.play().catch(() => {});
  }

  private onMediasoupState(state: "connected" | "disconnected" | "failed") {
    if (!this.busy || this.media?.provider !== "mediasoup") return;
    if (state === "connected") {
      this.mediasoupConnected = true;
      this.clearMediasoupDegrade();
      this.set({ reconnecting: false });
      return;
    }
    this.mediasoupConnected = false;
    this.set({ reconnecting: true });
    this.netLog(`ms-${state}`);
    if (state === "failed") return void this.requestTcpFallback();
    this.clearMediasoupDegrade();
    this.mediasoupDegradeTimer = setTimeout(() => void this.requestTcpFallback(), 4_000);
  }

  private clearMediasoupDegrade() {
    if (this.mediasoupDegradeTimer) clearTimeout(this.mediasoupDegradeTimer);
    this.mediasoupDegradeTimer = null;
  }

  private async requestTcpFallback() {
    const callId = this.s.call?.id;
    if (!callId || this.fallbackInFlight || this.media?.provider !== "mediasoup") return;
    this.fallbackInFlight = true;
    try {
      const r = await this.req<{ ok: boolean; media?: CallMedia | null; error?: string }>("call:mediaFallback", { callId }, 6_000);
      if (!r.ok || !r.media || r.media.provider !== "livekit") throw new Error(r.error ?? "TCP fallback unavailable");
      await this.switchMedia(r.media);
    } catch {
      // The server keeps the call's normal reconnect grace; displaying the failure is preferable to a falsely active
      // call if both direct UDP and the durable TCP path are unavailable.
      this.set({ error: "Couldn't reconnect the call" });
    } finally {
      this.fallbackInFlight = false;
    }
  }

  private onMediaFallback = (d: { call?: CallInfo; media?: CallMedia | null; from?: string; to?: string }) => {
    if (!d?.call || d.call.id !== this.s.call?.id || d.media?.provider !== "livekit") return;
    // A callee can receive the switch while still looking at the incoming-call screen. Update the credential but do
    // not connect or prompt for media until they press Accept.
    if (this.s.ui === "incoming") {
      this.media = d.media;
      this.clearMediasoupDegrade();
      return;
    }
    void this.switchMedia(d.media, d.call);
  };

  private async switchMedia(media: CallMedia, call?: CallInfo) {
    if (!this.busy || this.media?.provider === media.provider && this.media.token === media.token) return;
    this.clearMediasoupDegrade();
    this.dropMediaForRejoin();
    this.media = media;
    this.roomPromise = null;
    if (call) this.set({ call });
    this.netLog("media-fallback-livekit");
    await this.connect(true);
  }

  private wire(LK: LK, room: Room) {
    const { RoomEvent, Track, ConnectionQuality } = LK;
    room.removeAllListeners();
    const q = (c: unknown): Quality =>
      c === ConnectionQuality.Excellent ? "excellent" : c === ConnectionQuality.Good ? "good" : c === ConnectionQuality.Poor ? "poor" : c === ConnectionQuality.Lost ? "lost" : "unknown";
    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.dataset.olCallAudio = "1";
          el.setAttribute("playsinline", "true");
          el.autoplay = true;
          document.body.appendChild(el);
          this.audioEls.push(el);
          if (this.s.speaker && this.sinkIds[1]) void (el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(this.sinkIds[1]).catch(() => {});
          const onPlay = () => this.firstAudio();
          el.addEventListener("playing", onPlay, { once: true });
          if (!el.paused) this.firstAudio();
        } else if (track.kind === Track.Kind.Video) {
          this.remoteVideo = track;
          if (this.videoEls.remote) track.attach(this.videoEls.remote);
          this.set({ remoteCam: !track.isMuted, videoInvite: !this.s.camOn });
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        track.detach().forEach((el) => {
          if ((el as HTMLElement).dataset?.olCallAudio) el.remove();
        });
        if (track.kind === Track.Kind.Video) {
          this.remoteVideo = null;
          this.set({ remoteCam: false, videoInvite: false });
        }
      })
      .on(RoomEvent.TrackMuted, (pub, p) => {
        if (p.isLocal) return;
        if (pub.kind === Track.Kind.Audio) this.set({ remoteMuted: true });
        if (pub.kind === Track.Kind.Video) this.set({ remoteCam: false });
      })
      .on(RoomEvent.TrackUnmuted, (pub, p) => {
        if (p.isLocal) return;
        if (pub.kind === Track.Kind.Audio) this.set({ remoteMuted: false });
        if (pub.kind === Track.Kind.Video) this.set({ remoteCam: true });
      })
      .on(RoomEvent.ConnectionQualityChanged, (quality, p) => {
        // show the worse of the two links
        const mine = q(room.localParticipant.connectionQuality);
        let theirs: Quality = "unknown";
        room.remoteParticipants.forEach((rp) => (theirs = q(rp.connectionQuality)));
        const order: Quality[] = ["lost", "poor", "good", "excellent", "unknown"];
        const worst = order.find((o) => o === mine || o === theirs) ?? "unknown";
        void quality;
        void p;
        this.setQuality(worst);
      })
      .on(RoomEvent.Reconnecting, () => {
        this.set({ reconnecting: true });
        this.netLog("lk-reconnecting");
      })
      .on(RoomEvent.Reconnected, () => {
        this.set({ reconnecting: false });
        this.netLog("lk-reconnected");
      })
      .on(RoomEvent.ParticipantDisconnected, () => this.busy && this.s.ui === "active" && this.set({ peerReconnecting: true }))
      .on(RoomEvent.ParticipantConnected, () => this.set({ peerReconnecting: false }))
      .on(RoomEvent.AudioPlaybackStatusChanged, () => this.set({ needsGesture: !room.canPlaybackAudio }))
      .on(RoomEvent.Connected, () => this.watchStall(room))
      .on(RoomEvent.Disconnected, () => {
        if (this.room !== room || !this.busy) return;
        // LiveKit's own resume (ICE restart) and full-reconnect attempts are exhausted: rejoin ourselves with a fresh
        // token, republishing mic/camera, for as long as the server keeps the call (45 s grace) — never hang up here.
        this.netLog("lk-disconnected");
        void this.rejoin("lk-disconnected");
      });
  }

  // ---------- reconnect ----------
  private rejoining = false;
  private wake: (() => void) | null = null;
  /** give up locally only when we can't even reach our server for this long (it ends the call after 45 s) */
  static LOCAL_GIVEUP_MS = 60_000;

  private netLog(ev: string, extra: Record<string, unknown> = {}) {
    try {
      const w = window as unknown as { __olCallNet?: { ev: string; t: number }[] };
      (w.__olCallNet ??= []).push({ ev, t: Date.now(), ...extra });
    } catch {
      /* ignore */
    }
  }

  /** Tear down only the media connection (keep the call, its timer and UI); local tracks are re-acquired on rejoin. */
  private dropMediaForRejoin() {
    const room = this.room;
    this.room = null;
    this.roomPromise = null;
    if (room) {
      room.removeAllListeners();
      void room.disconnect(true).catch(() => {});
    }
    const mediasoup = this.mediasoup;
    this.mediasoup = null;
    this.mediasoupConnected = false;
    mediasoup?.close();
    this.mediasoupLocalVideo = null;
    this.mediasoupRemoteVideo = null;
    this.clearMediasoupDegrade();
    this.clearMicVoiceProcessing();
    void this.preMic?.then((t) => t?.stop());
    this.preMic = null;
    this.micTrack?.stop();
    this.micTrack = null;
    this.camTrack?.stop();
    this.camTrack = null;
    for (const el of this.audioEls) el.remove();
    this.audioEls = [];
  }

  /** Rejoin the call's LiveKit room: re-sync with the server (call:get → still on? fresh token), reconnect, republish. */
  private async rejoin(reason: string) {
    if (this.rejoining) return;
    const callId = this.s.call?.id;
    if (!callId) return;
    this.rejoining = true;
    const t0 = Date.now();
    this.set({ reconnecting: true });
    this.dropMediaForRejoin();
    const delays = [300, 1000, 2000, 3000, 5000];
    let attempt = 0;
    try {
      while (this.busy && this.s.call?.id === callId) {
        const online = typeof navigator === "undefined" || navigator.onLine !== false;
        if (online) {
          const g = await this.req<{ ok: boolean; call?: CallInfo; media?: CallMedia | null; error?: string }>("call:get", { callId }, 4000).catch(() => null);
          if (g && (!g.ok || g.call?.phase === "ended")) {
            // the server ended it (grace ran out / the other side hung up): show the real outcome, no false "missed"
            const call = g.call ?? this.s.call;
            if (call) this.finishLocal(g.call?.outcome ?? "completed", false, { ...call, phase: "ended" }, "connection_lost");
            return;
          }
          if (g?.ok && g.call) {
            if (g.media) this.media = g.media;
            this.netLog("rejoin-attempt", { attempt, reason });
            const connection = await this.connect(true);
            if (connection && this.mediaConnected()) {
              this.set({ reconnecting: false, call: g.call });
              this.netLog("rejoined", { ms: Date.now() - t0, attempt });
              return;
            }
            this.dropMediaForRejoin();
          }
        }
        if (Date.now() - t0 > CallEngine.LOCAL_GIVEUP_MS) {
          const call = this.s.call;
          if (call?.id) void this.req("call:hangup", { callId: call.id }, 3000).catch(() => {});
          this.teardownMedia();
          if (call) this.endWith(call, "Call ended · connection lost", true);
          this.netLog("gave-up", { ms: Date.now() - t0 });
          return;
        }
        await new Promise<void>((r) => {
          const t = setTimeout(r, delays[Math.min(attempt, delays.length - 1)]);
          this.wake = () => (clearTimeout(t), r());
        });
        this.wake = null;
        attempt++;
      }
    } finally {
      this.rejoining = false;
    }
  }

  private stallTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Silent loss (tunnel, dead Wi-Fi that still looks "online"): ICE only notices after its consent timeout, so watch
   * the bytes. The other side's audio (Opus+DTX keeps sending during silence) stopping for 3 s while they're not muted
   * means the media path is gone: say so right away — "Reconnecting…" when our own signal is also stale, "<name> is
   * reconnecting…" when LiveKit still tells us their link is lost — and clear it as soon as bytes flow again.
   */
  private watchStall(room: Room) {
    if (this.stallTimer) clearInterval(this.stallTimer);
    let last = -1;
    let still = 0;
    let soft = false;
    this.stallTimer = setInterval(async () => {
      if (this.room !== room || !this.busy) {
        if (this.stallTimer) clearInterval(this.stallTimer);
        this.stallTimer = null;
        return;
      }
      if (this.s.ui !== "active" || this.rejoining) return;
      let track: RemoteTrack | undefined;
      let peerQ: unknown;
      room.remoteParticipants.forEach((rp) => {
        peerQ = rp.connectionQuality;
        rp.audioTrackPublications.forEach((pub) => (track = !pub.isMuted && pub.track ? (pub.track as RemoteTrack) : track));
      });
      if (!track) return void (last = -1);
      let bytes = 0;
      try {
        (await track.getRTCStatsReport())?.forEach((r: { type?: string; bytesReceived?: number }) => r.type === "inbound-rtp" && (bytes += r.bytesReceived ?? 0));
      } catch {
        return;
      }
      if (bytes === last) still++;
      else still = 0;
      last = bytes;
      if (still >= 3 && !soft) {
        soft = true;
        const peerLost = String(peerQ) === "lost";
        this.netLog("media-stall", { peerLost });
        if (peerLost) this.set({ peerReconnecting: true });
        else this.set({ reconnecting: true });
      } else if (still === 0 && soft) {
        soft = false;
        this.netLog("media-flowing");
        this.set({ reconnecting: room.state !== "connected", peerReconnecting: false });
      }
    }, 1000);
  }

  private onPeer = (d: { callId: string; userId: string; online: boolean }) => {
    if (!d || d.callId !== this.s.call?.id || d.userId === this.meId) return;
    this.set({ peerReconnecting: !d.online });
    this.netLog(d.online ? "peer-online" : "peer-offline");
  };

  private netWatched = false;
  private lastNetType: string | null = null;
  private netTimer: ReturnType<typeof setTimeout> | null = null;
  /** Network changes (Wi-Fi ↔ cellular, IP change, offline/online): refresh the media path right away instead of
   *  waiting for ICE consent to time out. LiveKit resumes with an ICE restart; if it has given up, we rejoin. */
  private watchNetwork() {
    if (this.netWatched || typeof window === "undefined") return;
    this.netWatched = true;
    const conn = (navigator as unknown as { connection?: EventTarget & { type?: string; effectiveType?: string } }).connection;
    this.lastNetType = conn?.type ?? null;
    const refresh = (why: string) => {
      if (this.netTimer) clearTimeout(this.netTimer);
      this.netTimer = setTimeout(() => {
        if (!this.busy || (this.s.ui !== "active" && this.s.ui !== "connecting")) return;
        this.netLog("net-change", { why });
        const room = this.room;
        if (this.mediasoup) {
          // Direct UDP cannot safely migrate itself after an interface change. Select the proven TCP backend instead.
          void this.requestTcpFallback();
        } else if (!room) {
          if (this.rejoining) this.wake?.();
          else void this.rejoin(why);
        } else if (room.state === "connected") {
          // public LiveKit API that performs a real resume: signal reconnect + ICE restart on the new interface
          void room.simulateScenario("resume-reconnect").catch(() => {});
        }
        // reconnecting: LiveKit's own 'online' handler retries immediately
      }, 800);
    };
    window.addEventListener("offline", () => {
      if (this.busy && this.s.ui === "active") this.set({ reconnecting: true });
      this.netLog("offline");
    });
    window.addEventListener("online", () => {
      this.netLog("online");
      if (this.rejoining) this.wake?.();
      else if (this.busy && this.mediaConnected()) this.set({ reconnecting: false });
    });
    conn?.addEventListener?.("change", () => {
      const ty = conn.type ?? null;
      if (ty === this.lastNetType) return; // effectiveType wobble on the same network: ignore
      this.lastNetType = ty;
      if (navigator.onLine !== false) refresh(`connection:${ty}`);
    });
  }

  private setQuality(qy: Quality) {
    if (this.weakTimer) clearTimeout(this.weakTimer);
    // "Weak connection" only after it stays bad for 2 s (no flicker)
    if (qy === "poor" || qy === "lost") this.weakTimer = setTimeout(() => this.set({ quality: qy }), 2000);
    else this.set({ quality: qy });
  }

  private firstAudio() {
    if (this.metricSent || !this.acceptT0 || !this.s.call?.id) return;
    this.metricSent = true;
    const ms = Math.round(performance.now() - this.acceptT0);
    mark("first-audio");
    (window as unknown as { __olCallMetric?: number[] }).__olCallMetric = [...((window as unknown as { __olCallMetric?: number[] }).__olCallMetric ?? []), ms];
    void this.req("call:metric", { callId: this.s.call.id, acceptToAudioMs: ms }).catch(() => {});
  }

  private async detectSpeaker() {
    // in-app (build 18+) the wrapper routes audio; on the web only browsers with setSinkId + several outputs can switch
    if ((window as unknown as { __olNativeCalls?: unknown }).__olNativeCalls) return true;
    try {
      if (!("setSinkId" in HTMLMediaElement.prototype) || !navigator.mediaDevices?.enumerateDevices) return false;
      const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput" && d.deviceId);
      this.sinkIds = outs.map((d) => d.deviceId);
      return outs.length > 1;
    } catch {
      return false;
    }
  }

  private teardownMedia() {
    stopTones();
    const room = this.room;
    this.room = null;
    this.roomPromise = null;
    if (room) {
      room.removeAllListeners();
      void room.disconnect();
    }
    const mediasoup = this.mediasoup;
    this.mediasoup = null;
    this.mediasoupConnected = false;
    mediasoup?.close();
    this.mediasoupLocalVideo = null;
    this.mediasoupRemoteVideo = null;
    this.clearMediasoupDegrade();
    this.clearMicVoiceProcessing();
    void this.preMic?.then((t) => t?.stop());
    this.preMic = null;
    this.micTrack?.stop();
    this.micTrack = null;
    this.camTrack?.stop();
    this.camTrack = null;
    this.remoteVideo = null;
    for (const el of this.audioEls) el.remove();
    this.audioEls = [];
    document.querySelectorAll("[data-ol-call-audio]").forEach((el) => el.remove());
    this.media = null;
    this.acceptedHere = false;
    this.acceptT0 = 0;
    this.metricSent = false;
    this.fallbackInFlight = false;
    if (this.weakTimer) clearTimeout(this.weakTimer);
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.stallTimer = null;
  }

  private clearMicVoiceProcessing() {
    this.micVoiceProcessing?.dispose();
    this.micVoiceProcessing = null;
  }

  // ---------- controls ----------
  async toggleMute() {
    const muted = !this.s.muted;
    this.set({ muted });
    buzz("light");
    if (this.mediasoup) await this.mediasoup.setMuted(muted).catch(() => {});
    const t = this.micTrack;
    if (t) await (muted ? t.mute() : t.unmute()).catch(() => {});
    postNative({ type: "call:muted", muted });
  }

  async toggleCam() {
    const on = !this.s.camOn;
    buzz("light");
    const call = this.s.call;
    if (this.mediasoup) {
      try {
        if (on) await this.mediasoup.enableCamera(this.s.facing);
        else await this.mediasoup.disableCamera();
        this.set({ camOn: on, videoInvite: false });
      } catch {
        this.set({ camOn: false, error: "Camera unavailable. Continuing with audio." });
        return;
      }
      if (call?.id) void this.req("call:video", { callId: call.id, on }).catch(() => {});
      return;
    }
    if (on) {
      const cam = await this.ensureCamPreview();
      if (!cam) return;
      this.set({ camOn: true, videoInvite: false });
      const room = this.room;
      if (room?.state === "connected" && lk) {
        const pub = room.localParticipant.getTrackPublication(lk.Track.Source.Camera);
        if (pub?.track) await (pub.track as LocalVideoTrack).unmute();
        else await publishCamera(lk, room, cam, currentCodecChoice(nativePlatform()), browserNetworkTier()).catch(() => {});
      }
    } else {
      this.set({ camOn: false });
      const room = this.room;
      if (room && lk && this.camTrack) await room.localParticipant.unpublishTrack(this.camTrack, true).catch(() => {});
      this.camTrack?.stop();
      this.camTrack = null;
    }
    if (call?.id) void this.req("call:video", { callId: call.id, on }).catch(() => {});
  }

  async flip() {
    const facing = this.s.facing === "user" ? "environment" : "user";
    buzz("light");
    if (this.mediasoup) {
      try {
        await this.mediasoup.flipCamera(facing);
        this.set({ facing });
      } catch {
        this.set({ error: "Couldn't switch camera" });
      }
      return;
    }
    const t = this.camTrack;
    if (!t) return this.set({ facing });
    try {
      await t.restartTrack({ facingMode: facing });
      this.set({ facing });
    } catch {
      this.set({ error: "Couldn't switch camera" });
    }
  }

  async toggleSpeaker() {
    const speaker = !this.s.speaker;
    this.set({ speaker });
    buzz("light");
    postNative({ type: "call:audioRoute", speaker });
    const id = speaker ? this.sinkIds[1] : this.sinkIds[0];
    if (!id) return;
    for (const el of this.audioEls) await (el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(id).catch(() => {});
  }

  setMinimized(minimized: boolean) {
    this.set({ minimized });
  }
  clearError() {
    this.set({ error: null });
  }
  dismissVideoInvite() {
    this.set({ videoInvite: false });
  }
  async startAudio() {
    unlockAudio();
    if (this.mediasoup) {
      const playing = await this.mediasoup.startAudio().catch(() => false);
      this.set({ needsGesture: !playing });
      return;
    }
    await this.room?.startAudio().catch(() => {});
    this.set({ needsGesture: this.room ? !this.room.canPlaybackAudio : false });
  }

  /** video elements from the UI (PiP / full screen); null detaches */
  attachVideo(which: "local" | "remote", el: HTMLVideoElement | null) {
    const prev = this.videoEls[which];
    if (this.mediasoup) {
      this.videoEls[which] = el;
      this.attachRawVideo(el, which === "local" ? this.mediasoupLocalVideo : this.mediasoupRemoteVideo);
      if (prev && prev !== el) prev.srcObject = null;
      return;
    }
    const track = which === "local" ? this.camTrack : this.remoteVideo;
    if (prev && track) track.detach(prev);
    this.videoEls[which] = el;
    if (el && track) track.attach(el);
  }
}

async function micPermission(): Promise<"granted" | "denied" | "prompt" | "unknown"> {
  try {
    const p = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return p.state;
  } catch {
    return "unknown"; // Firefox / old Safari: don't pre-acquire (it would prompt before Accept)
  }
}

export const fmt = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

export const callEngine = typeof window !== "undefined" ? new CallEngine() : (null as unknown as CallEngine);
