// Client call engine: one per app. Owns the call state machine on this device, the LiveKit connection, local
// mic/camera tracks, remote media, sounds and timing. React reads it through useSyncExternalStore (useCall).
//
// Speed (accept → first audio): both LiveKit tokens are minted at ring time; while it rings the callee's device
// loads the LiveKit client, pre-opens the signalling connection (prepareConnection) and, if mic permission is
// already granted, pre-acquires the mic. Accepting then just connects + publishes. The caller is already in the
// LiveKit room publishing when the callee joins, so audio flows the moment the callee's transport is up.
import { swapVideoTrack } from "./frameHold";
import type { CallInfo, CallMedia, CallOutcome } from "@/lib/types";
import type { RealtimeClient } from "@/lib/realtime";
import type { LocalAudioTrack, LocalVideoTrack, RemoteTrack, Room } from "livekit-client";
import { native, nativePlatform } from "@/lib/native";
import { applyCameraCaptureQuality, applyCameraQualityHint, browserNetworkTier, browserUsesNativeMobileCameraFrame, captureResolution, currentCodecChoice, micPublishOptions, publishCamera, publishDefaults, type NetworkTier } from "./videoPolicy";
import { audioContext, unlockAudio } from "@/lib/audioUnlock";
import { enableVoiceProcessing, type VoiceProcessingHandle } from "./voiceProcessing";
import { playBusy, playConnected, playHangup, playRingback, playRingtone, ringing, stopTones } from "./tones";
import { livekitRtcConfig } from "@/lib/livekitIce";
import { MediasoupCallSession, type MediasoupRemoteTrack } from "./mediasoupSession";
import { flipCameraTrack } from "./cameraFlip";
import { CALL_AUDIO_CONSTRAINTS, resumePausedCallAudio, useRawDirectCallMicrophone } from "./audioPolicy";
import { QUALITY_SAMPLE_MS, QualityGuard, countersFromStats } from "./qualityGuard";
import { followAudioDevices } from "../audioDevices";

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
  private qualityTimer: ReturnType<typeof setInterval> | null = null;
  private readonly qualityGuard = new QualityGuard();
  private fallbackInFlight = false;
  private micTrack: LocalAudioTrack | null = null;
  /** Headset follow: re-acquire the mic when a wired/USB-C/Bluetooth headset is connected or removed. */
  private stopDeviceFollow: (() => void) | null = null;
  private preMic: Promise<LocalAudioTrack | null> | null = null;
  private micVoiceProcessing: VoiceProcessingHandle | null = null;
  private camTrack: LocalVideoTrack | null = null;
  /** Ignore repeated taps while a mobile camera capture / sender replacement is in flight. */
  private flippingCamera = false;
  private remoteVideo: RemoteTrack | null = null;
  private audioEls: HTMLMediaElement[] = [];
  /** Each visible feed has a native-aspect foreground plus a blurred duplicate fill. */
  private videoEls = { local: [] as HTMLVideoElement[], remote: [] as HTMLVideoElement[] };
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

  /** Retryable start failures: the socket isn't open yet, or it is open but the session hasn't resumed on it yet. */
  static isNotReady(r: { ok: boolean; error?: string }) {
    return !r.ok && /not connected|not signed in|no connection/i.test(r.error ?? "");
  }
  static START_WAIT_MS = 8_000;
  /** call:start, retried while the connection is (re)establishing — a tap right after page load / resume isn't lost.
   *  Safe to repeat: the server hands back the same call for the same pair. Times out to "Couldn't start the call". */
  private async startWhenConnected(peerId: string, video: boolean): Promise<{ ok: boolean; call?: CallInfo; media?: CallMedia | null; error?: string; reason?: string }> {
    const until = Date.now() + CallEngine.START_WAIT_MS;
    let attempt = 0;
    for (;;) {
      let r: { ok: boolean; call?: CallInfo; media?: CallMedia | null; error?: string; reason?: string } | null = null;
      try {
        r = await this.req("call:start", { peerId, video }, Math.max(1_000, Math.min(10_000, until - Date.now())));
      } catch {
        r = null;
      }
      if (r && !CallEngine.isNotReady(r)) return r;
      // no reply at all (not open / dropped / timed out) is always retryable until the deadline
      if (!this.busy || this.s.ui !== "outgoing") return { ok: false, reason: "cancelled" };
      if (Date.now() >= until) return { ok: false, error: "Couldn't start the call" };
      this.netLog("start-retry", { attempt: ++attempt });
      await new Promise((res) => setTimeout(res, Math.min(250 * attempt, 1_000)));
    }
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
    playRingback({ video, untilMs: ringUntil(optimistic) });
    void loadLK().catch(() => {});
    // mic (and camera) permission prompt happens now, inside the tap, in parallel with the server round trip
    this.preMic = this.acquireMic();
    if (video) void this.ensureCamPreview();
    let r: { ok: boolean; call?: CallInfo; media?: CallMedia | null; error?: string; reason?: string };
    r = await this.startWhenConnected(peer.id, video);
    if (r.reason === "cancelled") return; // hung up while the connection was coming back
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
    if (ringing() !== "outgoing") playRingback({ video, untilMs: ringUntil(r.call) });
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
    playRingtone({ video: call.video, untilMs: ringUntil(call) });
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
    this.set({ ui: "connecting", camOn: withVideo, error: null });
    if (this.media?.provider === "livekit") {
      if (!this.preMic) this.preMic = this.acquireMic();
      if (withVideo) void this.ensureCamPreview();
    }
    // connect with the ring-time token right away, in parallel with telling the server
    const accepted = this.req<{ ok: boolean; call?: CallInfo; media?: CallMedia | null; error?: string }>("call:accept", { callId: call.id }).catch(() => ({ ok: false, error: "No connection" }) as const);
    if (!this.media) {
      const r = await accepted;
      if (!r.ok) return this.acceptFailed(call, r.error);
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
      this.acceptFailed(call, r.error);
    } else if (r.call) this.set({ call: r.call, connectedAt: this.s.connectedAt ?? Date.now() });
  }

  /** Transient accept failure (socket blip) while the call still rings → back to the incoming card with a retry. */
  private acceptFailed(call: CallInfo, error?: string) {
    const stillRinging = error === "No connection" && this.s.call?.id === call.id && ringUntil(call) > Date.now() + 1_000;
    if (stillRinging) {
      this.acceptedHere = false;
      this.set({ ui: "incoming", error: "Couldn't answer — tap Accept to try again" });
      return;
    }
    this.endWith(call, error === "Call ended" ? "Call ended" : (error ?? "Couldn't answer"), false);
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
      if (ringing() !== "outgoing") playRingback({ video: call.video, untilMs: ringUntil(call) }); // already ringing since the tap
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
      audioCaptureDefaults: CALL_AUDIO_CONSTRAINTS,
      // Phone cameras choose their own upright native frame. Constraining an iPhone WKWebView to 9:16 can select a
      // cropped sensor mode; desktop capture keeps the quality preference below.
      videoCaptureDefaults: browserUsesNativeMobileCameraFrame() ? { facingMode: "user" } : { resolution: captureResolution(browserNetworkTier()), facingMode: "user" },
      // videoPolicy: Opus speech + DTX + RED at high priority; H.264 on capable phones (VP8 backup) else VP8;
      // simulcast q 180p/15fps/150k, h 360p/24fps/400k, f 1.2M/30fps
      publishDefaults: publishDefaults(LK, currentCodecChoice(nativePlatform()), browserNetworkTier()),
    });
  }

  private async acquireMic(): Promise<LocalAudioTrack | null> {
    try {
      const LK = await loadLK();
      const t = await LK.createLocalAudioTrack(CALL_AUDIO_CONSTRAINTS);
      if (!this.busy) {
        t.stop();
        return null;
      }
      // Browser AGC lifts ordinary speech; this final bounded gain + compressor improves quiet microphones without
      // clipping peaks. A suspended Web Audio destination is silent on iOS 15 / older Android WebViews, so attach it
      // only while the gesture-unlocked context is running (raw mic before that and during interruptions, swapped in place).
      this.clearMicVoiceProcessing();
      // Phones (iOS app / WKWebView, Android WebView, mobile Safari/Chrome) publish the raw AEC/NS/AGC mic, exactly like
      // the direct UDP path: after a CallKit / audio-focus interruption WebKit can report the context "running" while its
      // MediaStreamAudioDestinationNode emits silence, so the other side heard nothing on audio-only calls.
      // Desktop keeps the +3.5 dB gain + compressor (CALL_MIC_GAIN) from the loudness change.
      const context = useRawDirectCallMicrophone({ ua: typeof navigator !== "undefined" ? navigator.userAgent : "", nativePlatform: nativePlatform() }) ? null : audioContext();
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
      const t = await LK.createLocalVideoTrack(
        browserUsesNativeMobileCameraFrame()
          ? { facingMode: this.s.facing }
          : { facingMode: this.s.facing, resolution: captureResolution(browserNetworkTier()) },
      );
      applyCameraQualityHint(t.mediaStreamTrack);
      if (!this.busy) {
        t.stop();
        return null;
      }
      this.camTrack = t;
      this.logCameraTrack(t.mediaStreamTrack, "livekit-capture");
      for (const el of this.videoEls.local) t.attach(el);
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
          this.stopDeviceFollow?.();
          this.stopDeviceFollow = followAudioDevices(
            () => { const t = this.micTrack; if (t && this.room === room) void t.restartTrack().catch(() => {}); },
            () => this.micTrack?.mediaStreamTrack?.getSettings?.().deviceId,
          );
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
      this.startQualityGuard(session);
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
    this.stopDeviceFollow?.();
    this.stopDeviceFollow = null;
    this.micTrack?.stop();
    this.micTrack = null;
    this.camTrack?.stop();
    this.camTrack = null;
  }

  /** Foreground return on iOS/Android WebViews: replay any remote voice element the OS paused while hidden. */
  private onVisibleCallAudio = () => {
    if (document.visibilityState !== "visible" || this.audioEls.length === 0) return;
    void resumePausedCallAudio(this.audioEls).then((blocked) => blocked && this.set({ needsGesture: true }));
  };

  private onMediasoupTrack({ kind, track, close }: MediasoupRemoteTrack) {
    if (kind === "audio") {
      // One element per remote track: a repeated consumer notice or SFU re-consume must never play the voice twice.
      if (this.audioEls.some((x) => (x.srcObject as MediaStream | null)?.getAudioTracks?.().some((t) => t.id === track.id))) return;
      const el = document.createElement("audio");
      el.dataset.olCallAudio = "1";
      el.autoplay = true;
      el.setAttribute("playsinline", "true");
      el.srcObject = new MediaStream([track]);
      document.body.appendChild(el);
      this.audioEls.push(el);
      document.addEventListener("visibilitychange", this.onVisibleCallAudio);
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
    if (track) this.logCameraTrack(track, "mediasoup-capture");
    this.attachRawVideo(this.videoEls.local, track);
  }

  private attachRawVideo(els: readonly HTMLVideoElement[], track: MediaStreamTrack | null) {
    // #49: never clear or replace srcObject mid-call: swap the video track inside the same MediaStream so the
    // element keeps its last frame (frameHold.ts covers the gap) and resumes without a poster/blank flash.
    for (const el of els) swapVideoTrack(el, track);
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

  /** Sustained bad UDP quality (loss / RTT / bandwidth estimate / black-holed audio) → the LiveKit TCP/TURN-443 path. */
  private startQualityGuard(session: MediasoupCallSession) {
    this.stopQualityGuard();
    this.qualityGuard.reset();
    this.qualityTimer = setInterval(() => {
      if (this.mediasoup !== session || !this.busy || this.media?.provider !== "mediasoup") return this.stopQualityGuard();
      void session.getTransportStats().then((reports) => {
        if (this.mediasoup !== session) return;
        const v = this.qualityGuard.push(countersFromStats(reports), { remoteMuted: this.s.remoteMuted });
        if (!v) return;
        this.stopQualityGuard();
        this.netLog("ms-quality-fallback", { reasons: v.reasons.join(","), loss: v.lossPercent, rtt: v.rttMs, outKbps: v.outKbps });
        void this.requestTcpFallback();
      }).catch(() => {});
    }, QUALITY_SAMPLE_MS);
  }

  private stopQualityGuard() {
    if (this.qualityTimer) clearInterval(this.qualityTimer);
    this.qualityTimer = null;
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
          document.addEventListener("visibilitychange", this.onVisibleCallAudio);
          // Explicit play(): WKWebView after a CallKit answer (no page gesture) can leave an autoplay <audio> paused
          // on audio-only calls (a video call has a playing <video> that unblocks the page's media).
          if (el.paused) void el.play().catch(() => this.set({ needsGesture: true }));
          else this.firstAudio();
        } else if (track.kind === Track.Kind.Video) {
          this.remoteVideo = track;
          for (const el of this.videoEls.remote) track.attach(el);
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

  /** Debug-only in-memory trace for verifying portrait capture without recording media or device identifiers. */
  private logCameraTrack(track: MediaStreamTrack, source: string) {
    try {
      const settings = track.getSettings?.();
      const width = settings?.width;
      const height = settings?.height;
      this.netLog("camera-track", {
        source,
        width,
        height,
        aspectRatio: typeof width === "number" && typeof height === "number" && height > 0 ? Number((width / height).toFixed(4)) : undefined,
      });
    } catch {
      this.netLog("camera-track", { source });
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
    this.stopQualityGuard();
    this.mediasoupConnected = false;
    mediasoup?.close();
    this.mediasoupLocalVideo = null;
    this.mediasoupRemoteVideo = null;
    this.clearMediasoupDegrade();
    this.clearMicVoiceProcessing();
    void this.preMic?.then((t) => t?.stop());
    this.preMic = null;
    this.stopDeviceFollow?.();
    this.stopDeviceFollow = null;
    this.micTrack?.stop();
    this.micTrack = null;
    this.camTrack?.stop();
    this.camTrack = null;
    for (const el of this.audioEls) el.remove();
    this.audioEls = [];
    document.removeEventListener("visibilitychange", this.onVisibleCallAudio);
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
  private lastNetworkTier: NetworkTier = "normal";
  private netTimer: ReturnType<typeof setTimeout> | null = null;
  /** Network changes (Wi-Fi ↔ cellular, IP change, offline/online): refresh the media path right away instead of
   *  waiting for ICE consent to time out. LiveKit resumes with an ICE restart; if it has given up, we rejoin. */
  private watchNetwork() {
    if (this.netWatched || typeof window === "undefined") return;
    this.netWatched = true;
    // iOS wrapper: CallKit (de)activated the AVAudioSession → replay remote voice WebKit paused on the swap.
    window.addEventListener("openlounge:native-audio-resume", () => {
      if (this.audioEls.length) void resumePausedCallAudio(this.audioEls).then((blocked) => blocked && this.set({ needsGesture: true }));
    });
    const conn = (navigator as unknown as { connection?: EventTarget & { type?: string; effectiveType?: string } }).connection;
    this.lastNetType = conn?.type ?? null;
    this.lastNetworkTier = browserNetworkTier();
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
      const tier = browserNetworkTier();
      const tierChanged = tier !== this.lastNetworkTier;
      if (tierChanged) {
        this.lastNetworkTier = tier;
        void this.refreshCameraCaptureQuality(tier);
      }
      if (ty === this.lastNetType) return; // no interface migration; capture/encoder adaptation above is sufficient
      this.lastNetType = ty;
      if (navigator.onLine !== false) refresh(`connection:${ty}`);
    });
  }

  /** Preserve a live call while returning a desktop capture to 720p/30 after bandwidth recovers. */
  private async refreshCameraCaptureQuality(tier: NetworkTier) {
    try {
      if (this.mediasoup) {
        const changed = await this.mediasoup.refreshCameraQuality(this.s.facing, tier);
        if (changed) this.netLog("camera-capture-tier", { tier, provider: "mediasoup" });
        return;
      }
      const changed = await applyCameraCaptureQuality(this.camTrack?.mediaStreamTrack, this.s.facing, tier);
      if (changed) this.netLog("camera-capture-tier", { tier, provider: "livekit" });
    } catch {
      // Congestion control continues even if a device refuses a live constraint update; never interrupt the call.
      this.netLog("camera-capture-tier-rejected", { tier });
    }
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
    this.stopQualityGuard();
    this.mediasoupConnected = false;
    mediasoup?.close();
    this.mediasoupLocalVideo = null;
    this.mediasoupRemoteVideo = null;
    this.clearMediasoupDegrade();
    this.clearMicVoiceProcessing();
    void this.preMic?.then((t) => t?.stop());
    this.preMic = null;
    this.stopDeviceFollow?.();
    this.stopDeviceFollow = null;
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
    if (this.flippingCamera) return;
    const facing = this.s.facing === "user" ? "environment" : "user";
    buzz("light");
    this.flippingCamera = true;
    try {
      if (this.mediasoup) {
        await this.mediasoup.flipCamera(facing);
      } else {
        const t = this.camTrack;
        if (!t) {
          this.set({ facing });
          return;
        }
        // Do not call LocalVideoTrack.restartTrack(): it stops and detaches the active camera before requesting the
        // other lens. Pre-acquiring and replacing keeps the existing self-preview / publication live on an iOS or
        // Android capture failure.
        const next = await flipCameraTrack(t, facing);
        this.logCameraTrack(next, "livekit-flip");
      }
      this.set({ facing });
    } catch {
      this.set({ error: "Couldn't switch camera" });
    } finally {
      this.flippingCamera = false;
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

  /** Video elements from the UI (one per surface; the last-frame hold canvas lives in the component). */
  attachVideo(which: "local" | "remote", elements: HTMLVideoElement | readonly HTMLVideoElement[] | null) {
    const prev = this.videoEls[which];
    const next = (Array.isArray(elements) ? elements : elements ? [elements] : []).filter((el, index, all) => all.indexOf(el) === index);
    if (this.mediasoup) {
      this.videoEls[which] = next;
      this.attachRawVideo(next, which === "local" ? this.mediasoupLocalVideo : this.mediasoupRemoteVideo);
      for (const el of prev) if (!next.includes(el)) el.srcObject = null;
      return;
    }
    const track = which === "local" ? this.camTrack : this.remoteVideo;
    if (track) for (const el of prev) track.detach(el);
    this.videoEls[which] = next;
    if (track) for (const el of next) track.attach(el);
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

/**
 * Local deadline for the ring sound. The server's ring window is expiresAt - createdAt (both server clock), so it is
 * applied from now on this device: comparing the server's absolute expiresAt with Date.now() cut the ring short (down
 * to the 3 s floor) whenever the phone's clock ran ahead of the server. The real stop is the ring state ending
 * (answer / decline / cancel / server timeout → stopTones); this is only the safety net, 2 s past the window.
 */
export function ringUntil(call: Pick<CallInfo, "createdAt" | "expiresAt">, now = Date.now()): number {
  const windowMs = call.expiresAt - call.createdAt;
  return now + (windowMs > 0 && windowMs < 120_000 ? windowMs : 45_000) + 2000;
}

export const fmt = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

export const callEngine = typeof window !== "undefined" ? new CallEngine() : (null as unknown as CallEngine);
