// Client call engine: one per app. Owns the call state machine on this device, the LiveKit connection, local
// mic/camera tracks, remote media, sounds and timing. React reads it through useSyncExternalStore (useCall).
//
// Speed (accept → first audio): both LiveKit tokens are minted at ring time; while it rings the callee's device
// loads the LiveKit client, pre-opens the signalling connection (prepareConnection) and, if mic permission is
// already granted, pre-acquires the mic. Accepting then just connects + publishes. The caller is already in the
// LiveKit room publishing when the callee joins, so audio flows the moment the callee's transport is up.
import { UdpRecoveryPolicy } from "./udpRecovery";
import { anyOnTcp, udpProbeDelay } from "./udpProbe";
import { watchVideoResilience } from "./videoResilience";
import { ensureCallReady } from "./permissions";
import { nextElsewhere, type ElsewhereCall } from "./elsewhere";
import { swapVideoTrack } from "./frameHold";
import type { CallInfo, CallMedia, CallOutcome } from "@/lib/types";
import type { RealtimeClient } from "@/lib/realtime";
import type { LocalAudioTrack, LocalVideoTrack, RemoteTrack, Room } from "livekit-client";
import { native, nativePlatform } from "@/lib/native";
import { applyCameraCaptureQuality, applyCameraQualityHint, browserNetworkTier, browserUsesNativeMobileCameraFrame, captureResolution, currentCodecChoice, micPublishOptions, publishCamera, publishDefaults, type NetworkTier } from "./videoPolicy";
import { audioContext, unlockAudio } from "@/lib/audioUnlock";
import { enableVoiceProcessing, type VoiceProcessingHandle } from "./voiceProcessing";
import { nativeRingbackMode, playBusy, playConnected, playHangup, playRingback, playRingtone, rearmRing, ringing, stopTones } from "./tones";
import { livekitRtcConfig } from "@/lib/livekitIce";
import { MediasoupCallSession, type MediasoupRemoteTrack } from "./mediasoupSession";
import { NativeMediaSession, disableAndroidNativeMedia, nativeMediaCmd, nativeMediaIsAndroid, useNativeMedia } from "./nativeMediaSession";
import { AndroidCallLifecycle, summarizeStats } from "./androidLifecycle";
import { isAndroidApp } from "@/lib/notify";

/** WebView media session or the iOS app's native media proxy (same surface) */
type CallMediaSession = MediasoupCallSession | NativeMediaSession;
import { flipCameraTrack } from "./cameraFlip";
import { CALL_AUDIO_CONSTRAINTS, resumePausedCallAudio, useRawDirectCallMicrophone } from "./audioPolicy";
import { QUALITY_SAMPLE_MS, QualityGuard, countersFromStats, judgeQuality, type QualityCounters } from "./qualityGuard";
import { ADAPT, LADDER, NetLadder, nativeAdaptiveEnabled, videoBpsFor } from "./netAdapt";
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
  /** app voice call on the native (audio-only) media path: no mid-call video toggle in the apps (Oct 17) */
  nativeAudio: boolean;
  /** the same account is in a call on ANOTHER device (display-only pill; never rings or takes audio here) */
  elsewhere: ElsewhereCall | null;
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
  nativeAudio: false,
  elsewhere: null,
  v: 0,
});

const mark = (n: string) => {
  try {
    performance.mark(`ol:call-${n}`);
  } catch {
    /* old WebView */
  }
};

/** native audio-session handovers that require the caller's mic to be re-bound to its live producer */
export const MIC_HANDOVER_REASONS = new Set(["callkit-activate", "callkit-activate-settle", "connected", "interruption-ended"]);

/** Survives a WebView reload (unlock / lock-screen answer): the call this device accepted, so the new page rejoins it
 *  instead of treating it as "answered elsewhere". sessionStorage is per-tab, so other devices never see it. */
const ACCEPTED_KEY = "ol:acceptedCall";
export function rememberAccepted(callId: string | null) {
  try {
    if (callId) sessionStorage.setItem(ACCEPTED_KEY, callId);
    else sessionStorage.removeItem(ACCEPTED_KEY);
  } catch { /* storage blocked */ }
}
export function acceptedBefore(callId: string): boolean {
  try { return !!callId && sessionStorage.getItem(ACCEPTED_KEY) === callId; } catch { return false; }
}

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
  private roomPromise: Promise<Room | CallMediaSession | null> | null = null;
  private mediasoup: CallMediaSession | null = null;
  private mediasoupConnected = false;
  private mediasoupLocalVideo: MediaStreamTrack | null = null;
  private mediasoupRemoteVideo: MediaStreamTrack | null = null;
  private mediasoupDegradeTimer: ReturnType<typeof setTimeout> | null = null;
  private qualityTimer: ReturnType<typeof setInterval> | null = null;
  private readonly qualityGuard = new QualityGuard();
  private fallbackInFlight = false;
  /** call id whose direct (SFU) media connected at least once: from then on an outage recovers on the SFU (ICE restart
   *  → transport rebuild, UDP primary), never by dropping into emergency LiveKit */
  private msEverConnected: string | null = null;
  private msRecovering = false;
  /** persistent UDP recovery: TCP is only a bridge; return to UDP with backoff + hysteresis until hang-up */
  private udpRecovery = new UdpRecoveryPolicy();
  private udpRecoveryTimer: ReturnType<typeof setInterval> | null = null;
  private fallbackRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private restoreInFlight = false;
  private micTrack: LocalAudioTrack | null = null;
  /** Headset follow: re-acquire the mic when a wired/USB-C/Bluetooth headset is connected or removed. */
  private stopDeviceFollow: (() => void) | null = null;
  private preMic: Promise<LocalAudioTrack | null> | null = null;
  /** web/Safari callee on the UDP path: raw mic captured inside the Answer tap (handed to the session) */
  private tapMic: Promise<MediaStreamTrack | null> | null = null;
  /** a native audio-session handover arrived before the mediasoup session existed */
  private micHandoverPending = false;
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
  /** outgoing native-media call: SFU join/prewarm held until answer so the native ringback stays loud */
  private deferNativeConnect = false;
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
    if (typeof window !== "undefined") (window as unknown as { __olCallLive?: boolean }).__olCallLive = this.busy;
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
      if (this.msRecovering) return void this.armStuckGuard(); // the SFU recovery loop owns this outage
      if (typeof navigator !== "undefined" && navigator.onLine === false) return void this.armStuckGuard();
      this.netLog("stuck-rejoin");
      void this.rejoin("stuck");
    }, CallEngine.STUCK_MS);
  }
  static STUCK_MS = 20_000;
  /** Socket (re)connected during a call — e.g. the WebView resumed after the iPhone call screen took over a push-woken
   *  answer: re-bind this connection to the call right away, adopt the server's state, and if media never came up
   *  (or dropped) once the first-connect budget is spent, rebuild it instead of sitting silent. */
  private onSocketBack = () => {
    this.socketUpAt = Date.now();
    const call = this.s.call;
    if (!call || !this.busy) return;
    this.diag("socket-back", { media: this.mediaConnected() });
    void this.req<{ ok: boolean; call?: CallInfo }>("call:get", { callId: call.id }, 5_000)
      .then((r) => {
        if (r?.call && this.s.call?.id === call.id) this.onState({ call: r.call });
        if (!this.busy || this.s.call?.id !== call.id) return;
        if (this.s.ui !== "active" && this.s.ui !== "connecting") return;
        if (this.deferNativeConnect || this.mediaConnected() || this.rejoining || this.msRecovering || this.fallbackInFlight) return;
        const firstConnectSpent = !this.firstConnectT0 || Date.now() - this.firstConnectT0 > this.firstConnectBudgetMs();
        if (firstConnectSpent) void this.rejoin("socket-back");
      })
      .catch(() => {});
  };

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
      this.socket.off("call:mediaRestore", this.onMediaRestore);
      this.socket.off("connect", this.onSocketBack);
    }
    this.socket = socket;
    if (!socket) return;
    socket.on("call:incoming", this.onIncoming);
    socket.on("call:state", this.onState);
    socket.on("call:video", this.onVideo);
    socket.on("call:peer", this.onPeer);
    socket.on("call:mediaFallback", this.onMediaFallback);
    socket.on("call:mediaRestore", this.onMediaRestore);
    socket.on("connect", this.onSocketBack);
    this.socketUpAt = Date.now();
    if (typeof document !== "undefined" && !this.resumeWatch) {
      this.resumeWatch = true;
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") this.resumedAt = Date.now(); });
    }
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
  async resume(attempt = 0): Promise<void> {
    try {
      const r = await this.req<{ ok: boolean; call?: CallInfo | null }>("call:current", {});
      if (!r.ok) {
        // socket connected but not authed yet (fresh page after a WebView reload / unlock): an "ok:false" here is
        // NOT "no call" — retry shortly, otherwise the reloaded callee never rejoins and the call drops.
        this.netLog("resume-retry", { attempt });
        if (attempt < 8) setTimeout(() => void this.resume(attempt + 1), 500 + attempt * 250);
        return;
      }
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
      if (!g.ok || !g.call) {
        if (!g.ok && attempt < 8) setTimeout(() => void this.resume(attempt + 1), 500 + attempt * 250);
        return;
      }
      const role = g.call.callerId === this.meId ? "caller" : "callee";
      if (g.call.phase === "active" && (role === "caller" || this.acceptedHere || this.s.call?.id === call.id || acceptedBefore(g.call.id))) {
        if (role === "callee") this.acceptedHere = true; // this device answered before a WebView reload / unlock
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
    // Glare, other order: their call reached us first. Tapping Call on the same person answers it.
    if (this.s.ui === "incoming" && this.s.call?.callerId === peer.id) {
      await this.accept(video || this.s.call.video);
      return { ok: true };
    }
    if (this.busy) return { ok: false, error: "You're already in a call" };
    unlockAudio();
    buzz("light");
    this.clearEnd();
    this.lastPeer = { id: peer.id, video };
    this.micHandoverPending = false;
    this.watchNativeAudio(); // native audio-session events must be heard while ringing (network watch stays connect-time)
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
    // mic (and camera) permission prompt happens now, inside the tap, in parallel with the server round trip.
    // Native-media iOS app: the APP grabs the mic + loads WebRTC now (before the invite); the page never captures.
    this.deferNativeConnect = false;
    if (useNativeMedia(video)) {
      this.preMic = Promise.resolve(null);
      // Loud native ringback until connect (Donny, Oct 17): the app's mic grab / WebRTC load flips the iPhone audio
      // session into call mode (earpiece, call volume) mid-ring, so while the native ringer rings, the prewarm and the
      // native SFU join wait for the callee's answer (onState → active).
      this.deferNativeConnect = nativeRingbackMode() !== "off";
      if (!this.deferNativeConnect) void nativeMediaCmd({ op: "prewarm" }).catch(() => {});
    } else this.preMic = this.acquireMic();
    // iOS: getUserMedia reconfigures the audio session and can leave the ringback element "playing" but silent
    void this.preMic.then(() => this.s.ui === "outgoing" && rearmRing(), () => this.s.ui === "outgoing" && rearmRing());
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
    // Glare: both people tapped Call at once. The server hands back the OTHER person's ringing call (we are its
    // callee) — answer it instead of ringing back forever on a call nobody on this side can accept.
    if (this.meId && r.call.callerId !== this.meId && r.call.calleeId === this.meId && r.call.phase !== "ended") {
      stopTones();
      this.media = r.media ?? this.media;
      if (r.call.phase === "active") {
        this.acceptedHere = true;
        rememberAccepted(r.call.id);
        this.set({ call: r.call, role: "callee", ui: "connecting" });
        void this.connect(true);
      } else {
        this.set({ call: r.call, role: "callee", ui: "incoming" });
        await this.accept(video);
      }
      return { ok: true };
    }
    if (ringing() !== "outgoing") playRingback({ video, untilMs: ringUntil(r.call) });
    this.media = r.media ?? null;
    this.set({ call: r.call });
    if (!this.media) {
      this.set({ error: "Calls aren't available right now" });
      void this.hangup();
      return { ok: false };
    }
    postNative({ type: "call:outgoing", callId: r.call.id, name: peer.name, video });
    this.diag("call-start", { video });
    if (!this.deferNativeConnect) void this.connect(false);
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
    const nativeMedia = useNativeMedia(call.video);
    if (this.media?.provider === "livekit" && !nativeMedia)
      void loadLK()
        .then((LK) => {
          if (!this.media || this.media.provider !== "livekit" || this.s.call?.id !== call.id) return;
          const room = this.newRoom(LK);
          this.room = room;
          void room.prepareConnection(this.media.url, this.media.token).catch(() => {});
        })
        .catch(() => {});
    if (this.media?.provider === "livekit" && !nativeMedia)
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
    rememberAccepted(call.id);
    this.set({ ui: "connecting", camOn: withVideo, error: null });
    this.diag("answered", {});
    if (useNativeMedia(withVideo || call.video)) void nativeMediaCmd({ op: "prewarm" }).catch(() => {});
    else if (this.media?.provider === "mediasoup" && !this.tapMic && typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
      // Safari/web: bind the mic inside the Answer tap (unlockAudio() above resumed the AudioContext in the same gesture)
      this.tapMic = navigator.mediaDevices
        .getUserMedia({ audio: CALL_AUDIO_CONSTRAINTS })
        .then((st) => st.getAudioTracks()[0] ?? null)
        .catch(() => null);
    }
    if (this.media?.provider === "livekit" && !useNativeMedia(withVideo || call.video)) {
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
    // Same account on several devices: join the media room only once the server confirms THIS device won the accept.
    // LiveKit identities are per user (the ring-time token is shared by every device), so a losing device that joined
    // early would knock the winner out of the room. Mic/camera are already warming above; this costs one round trip.
    const r = await accepted;
    if (!r.ok) {
      this.teardownMedia();
      this.acceptFailed(call, r.error);
      return;
    }
    void this.connect(true);
    if (r.call) this.set({ call: r.call, connectedAt: this.s.connectedAt ?? Date.now() });
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
    if (call) {
      const local = this.s.call?.id === call.id && (this.acceptedHere || this.s.role === "caller");
      const e = nextElsewhere(this.s.elsewhere, call, this.meId, local);
      if (e !== this.s.elsewhere) this.set({ elsewhere: e });
    }
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
        // answered on another device (same account): stop EVERY local ring surface within one event —
        // in-page tone + ring element (stopTones → releaseRingAudio), the SW notification (CallProvider sync →
        // stopBackgroundRing on ui change) and the native ring UI (CallKit / full-screen notification) here.
        stopTones();
        postNative({ type: "call:ended", callId: call.id, reason: "answered_elsewhere" });
        this.teardownMedia();
        this.set({ ...initial(), elsewhere: nextElsewhere(this.s.elsewhere, call, this.meId, false), v: this.s.v + 1 });
        return;
      }
      if (role === "caller" && this.s.ui === "outgoing") {
        stopTones();
        this.acceptT0 = performance.now();
        mark("accepted");
        this.set({ call, ui: this.mediaConnected() ? "active" : "connecting", connectedAt: Date.now() });
        if (this.mediaConnected()) playConnected();
        postNative({ type: "call:connected", callId: call.id });
        this.diag("answered", { deferred: this.deferNativeConnect });
        if (this.deferNativeConnect) {
          this.deferNativeConnect = false;
          void this.connect(false);
        }
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
    const unreachable = reason === "peer_unreachable";
    const text =
      unreachable
        ? `${name}'s phone lost connection — call didn't connect`
        : lost
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
    this.endWith(call, text, lost || unreachable || (role === "caller" && (outcome === "missed" || outcome === "declined" || outcome === "busy")));
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
      const denied = /NotAllowed|denied|Permission/i.test(msg);
      this.set({ error: denied ? "Allow microphone access to make calls" : "Couldn't use the microphone" });
      // Platform-specific fix (iOS / Android / web modules). Runs only AFTER the capture failed, so it never delays
      // getUserMedia out of the user's tap (Safari/WKWebView require the gesture).
      if (denied) void ensureCallReady({ video: false }).then((r) => { if (!r.ok && r.hint && this.busy) this.set({ error: r.hint }); }).catch(() => {});
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
  private connect(answer: boolean): Promise<Room | CallMediaSession | null> {
    if (this.roomPromise) return this.roomPromise;
    const media = this.media;
    if (!media) return Promise.resolve(null);
    // native-media iOS app: every backend (UDP/TCP SFU and emergency LiveKit) is joined by the app, never the WebView
    if (media.provider === "mediasoup" || useNativeMedia(!!this.s.call?.video || this.s.camOn)) {
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

  /** true while this device's direct media runs over the same SFU's ICE-TCP port (explicit fallback) */
  private msTcp = false;

  private async connectMediasoup(media: CallMedia, answer: boolean, tcpOnly = false): Promise<CallMediaSession | null> {
    try {
      // iOS app with native call media + audio-only call: the app owns mic/transports/audio session (no WebView media)
      const Session = useNativeMedia(!!this.s.call?.video || this.s.camOn) ? NativeMediaSession : MediasoupCallSession;
      // Web/Safari: hand the mic captured inside the Call/Answer tap to the UDP session (one capture, bound at the
      // gesture) instead of releasing it and capturing again later outside the gesture.
      const tapMic = Session === MediasoupCallSession && media.provider === "mediasoup" ? this.tapMic ?? this.preMic?.then((t) => t?.mediaStreamTrack ?? null) ?? null : null;
      if (tapMic) {
        this.preMic = null;
        this.tapMic = null;
      }
      // A caller may have pre-acquired LiveKit tracks before the backend selection response arrived. Release them so
      // iOS/Android never hold two microphone/camera captures while the UDP transport starts.
      this.releaseLiveKitPrewarm();
      const session: CallMediaSession = new (media.provider === "mediasoup" ? Session : NativeMediaSession)(this.socket!, media, {
        callId: this.s.call?.id,
        ...(this.msRecovering ? { rebuild: true } : {}),
        ...(tapMic ? { preTrack: tapMic.catch(() => null) } : {}),
        // a session parked for make-before-break (or superseded) must never drive this call's state
        onRemoteTrack: (track) => { if (this.mediasoup === session) this.onMediasoupTrack(track); },
        onState: (state) => { if (this.mediasoup === session) this.onMediasoupState(state); },
        onLocalVideo: (track) => { if (this.mediasoup === session) this.setMediasoupLocalVideo(track); },
        onWantsLiveKit: (reason) => { if (this.mediasoup === session) void this.nativeFailed(reason); },
        tcpOnly,
      });
      this.mediasoup = session;
      if (this.micHandoverPending) {
        this.micHandoverPending = false;
        session.rebindMic(); // runs as soon as the producer exists
      }
      if (this.s.nativeAudio !== session instanceof NativeMediaSession) this.set({ nativeAudio: session instanceof NativeMediaSession });
      const first = !this.msRecoveryOnly();
      if (first && !this.inFirstRetry) this.firstConnectT0 = Date.now();
      // first connect: one ~5 s budget across all silent attempts (ICE races direct UDP and the TURNS relay)
      // native-app LiveKit last resort (call d8d7eded): it used to race the already-spent first-connect budget (500 ms)
      await (media.provider === "livekit"
        ? Promise.race([session.connect(this.s.camOn), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("livekit join budget")), CallEngine.LIVEKIT_JOIN_BUDGET_MS))])
        : first
        ? Promise.race([session.connect(this.s.camOn), this.firstConnectBudget()])
        : session.connect(this.s.camOn));
      if (this.mediasoup !== session || !this.busy) {
        session.close();
        return null;
      }
      const firstMediaOk = this.msEverConnected !== (this.s.call?.id ?? null);
      this.mediasoupConnected = true;
      this.msEverConnected = this.s.call?.id ?? null;
      if (firstMediaOk) this.initCallRoute();
      this.clearMediasoupDegrade();
      this.startQualityGuard(session);
      this.startUdpProbe(session);
      this.startAndroidLifecycle(session);
      if (answer || this.s.call?.phase === "active") {
        if (this.s.ui === "connecting") {
          this.set({ ui: "active", connectedAt: this.s.connectedAt ?? Date.now(), reconnecting: false });
          playConnected();
          postNative({ type: "call:connected", callId: this.s.call?.id });
        }
      }
      return session;
    } catch (e) {
      if (this.busy && !tcpOnly) {
        const recovering = this.msRecoveryOnly();
        this.netLog("ms-connect-failed", { recovering, reason: String((e as Error)?.message ?? e).slice(0, 160), native: this.mediasoup instanceof NativeMediaSession });
        // Main SFU only (no LiveKit): a failed FIRST connect enters the same recovery as a mid-call outage — rebuild
        // the transports with backoff (each offers UDP, ICE-TCP 40443 and TURNS 443), keep the call, show
        // "Reconnecting…", end only on hangup / server end. Inside recovery the loop itself retries.
        // UDP-only (Donny, Oct 17): a FIRST connect that fails (ICE never succeeds within FIRST_CONNECT_BUDGET_MS, or the SFU
        // refuses) ends the attempt cleanly with a clear message — no endless "Reconnecting…". Persistent recovery is
        // only for calls that were connected over UDP and then dropped (bounded by MS_RECOVER_MAX_MS).
        // Android app native media: a failed FIRST connect goes to the LiveKit backup right away (its mediasoup error
        // repeats on every retry). Web and iOS keep the silent 5 s retry budget below.
        if (media.provider === "livekit") this.failUdpUnreachable("livekit-native", String((e as Error)?.message ?? e));
        else if (this.mediasoup instanceof NativeMediaSession && nativeMediaIsAndroid()) void this.androidNativeToWebView(String((e as Error)?.message ?? e));
        else if (!recovering && !this.inFirstRetry) void this.retryFirstConnect(String((e as Error)?.message ?? e));
      }
      return null;
    }
  }

  /** Same-SFU ICE-TCP (UDP-hostile network / ladder floor). False when the SFU has no TCP port or it can't connect. */
  private async switchToMediasoupTcp(): Promise<boolean> {
    if (!this.media || this.media.provider !== "mediasoup" || this.msTcp) return false;
    const media = this.media;
    this.clearMediasoupDegrade();
    this.parkMediaForSwitch();
    this.dropMediaForRejoin();
    this.media = media;
    const session = await this.connectMediasoup(media, true, true);
    if (!session) return false;
    this.msTcp = true;
    this.netLog("ms-tcp-fallback");
    return true;
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
    if (document.visibilityState !== "visible") return;
    // back from a GSM call / lock screen on Android & browsers: a mic the OS muted meanwhile is recaptured
    this.mediasoup?.checkMicAlive();
    if (this.audioEls.length === 0) return;
    void resumePausedCallAudio(this.audioEls).then((blocked) => blocked && this.set({ needsGesture: true }));
  };

  /** receive-side video sturdiness (never touches senders/encoders) */
  private stopVideoResilience: (() => void) | null = null;
  private startVideoResilience(receiver: RTCRtpReceiver | null | undefined) {
    this.stopVideoResilience?.();
    this.stopVideoResilience = watchVideoResilience(receiver, (ev, x) => this.netLog(ev, x));
  }

  private onMediasoupTrack({ kind, track, close, receiver }: MediasoupRemoteTrack) {
    if (kind === "video") this.startVideoResilience(receiver);
    if (kind === "audio") {
      // One element per remote track: a repeated consumer notice or SFU re-consume must never play the voice twice.
      if (this.audioEls.some((x) => (x.srcObject as MediaStream | null)?.getAudioTracks?.().some((t) => t.id === track.id))) return;
      const el = document.createElement("audio");
      el.dataset.olCallAudio = "1";
      el.autoplay = true;
      el.setAttribute("playsinline", "true");
      el.volume = 1; // full element gain: never inherit a lowered volume from a reused/ring element
      el.muted = false;
      el.srcObject = new MediaStream([track]);
      document.body.appendChild(el);
      this.audioEls.push(el);
      document.addEventListener("visibilitychange", this.onVisibleCallAudio);
      const onPlay = () => {
        this.releaseParked();
        this.firstAudio();
      };
      el.addEventListener("playing", onPlay, { once: true });
      void el.play().catch((e: unknown) => {
        this.diag("remote-audio-play-failed", { path: "mediasoup", err: String((e as Error)?.name ?? e).slice(0, 60), vis: document.visibilityState });
        this.set({ needsGesture: true });
      });
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
    if (!this.busy) return;
    if (this.media?.provider !== "mediasoup") {
      // native-media app on the emergency LiveKit path: its own reconnects failed → keep reconnecting via rejoin
      if (!(this.mediasoup instanceof NativeMediaSession)) return;
      if (state === "connected") {
        this.mediasoupConnected = true;
        return void this.set({ reconnecting: false });
      }
      this.mediasoupConnected = false;
      this.set({ reconnecting: true });
      if (state === "failed" && !this.rejoining) void this.rejoin("native-lk-failed");
      return;
    }
    if (state === "connected") {
      this.mediasoupConnected = true;
      this.clearMediasoupDegrade();
      this.set({ reconnecting: false });
      return;
    }
    // first connect (never connected on the SFU in this call): a transient disconnected/failed is not fatal and shows
    // no "Reconnecting…"; the connect budget + silent retries (retryFirstConnect) own this phase
    if (!this.msRecoveryOnly()) {
      this.netLog(`ms-${state}-first`);
      return;
    }
    this.mediasoupConnected = false;
    this.set({ reconnecting: true });
    this.netLog(`ms-${state}`);
    if (this.msRecoveryOnly()) {
      // persistent reconnecting on the SFU: ICE restart in place, then rebuild the transports (UDP primary)
      this.stopQualityGuard(); // a dead path reads as "black-holed": never let that pick emergency LiveKit
      if (this.msRecovering) return;
      this.clearMediasoupDegrade();
      this.mediasoupDegradeTimer = setTimeout(() => void this.recoverMediasoup(state), state === "failed" ? 0 : CallEngine.MS_RECOVER_GRACE_MS);
      return;
    }
    if (state === "failed") return void this.requestTcpFallback();
    this.clearMediasoupDegrade();
    this.mediasoupDegradeTimer = setTimeout(() => void this.requestTcpFallback(), 8_000);
  }

  /** Sustained bad UDP quality (loss / RTT / bandwidth estimate / black-holed audio) → the LiveKit TCP/TURN-443 path. */
  private startQualityGuard(session: CallMediaSession) {
    this.stopQualityGuard();
    this.qualityGuard.reset();
    // bandwidth-aware ladder on every platform (single encoding, no simulcast); QualityGuard path kept unreachable-safe
    return this.startNetLadder(session);
    this.qualityTimer = setInterval(() => {
      if (this.mediasoup !== session || !this.busy || this.media?.provider !== "mediasoup") return this.stopQualityGuard();
      void session.getTransportStats().then((reports) => {
        if (this.mediasoup !== session || !this.mediasoupConnected || this.msRecovering) return;
        const v = this.qualityGuard.push(countersFromStats(reports), { remoteMuted: this.s.remoteMuted });
        if (!v) return;
        this.stopQualityGuard();
        this.netLog("ms-quality-fallback", { reasons: v.reasons.join(","), loss: v.lossPercent, rtt: v.rttMs, outKbps: v.outKbps });
        void this.requestTcpFallback();
      }).catch(() => {});
    }, QUALITY_SAMPLE_MS);
  }

  /** Native apps only: coordinated audio+video ladder first, TCP only when the floor still can't hold (netAdapt.ts). */
  private readonly netLadder = new NetLadder();
  private ladderCallId: string | null = null;
  private startNetLadder(session: CallMediaSession) {
    // after a reconnect within the same call: conservative rung first, then climb on measured headroom
    const callId = this.s.call?.id ?? null;
    const startLevel = callId && this.ladderCallId === callId ? ADAPT.reconnectLevel : 0;
    this.ladderCallId = callId;
    this.netLadder.reset(startLevel);
    if (startLevel > 0) void session.applyLadderStep(LADDER[startLevel]);
    let lastVideoBps = 0;
    let prev: QualityCounters | null = null;
    const w = window as unknown as { __olNetLadder?: { level: number; changes: { t: number; level: number; dir: string }[] } };
    w.__olNetLadder = { level: 0, changes: [] };
    this.qualityTimer = setInterval(() => {
      if (this.mediasoup !== session || !this.busy || this.media?.provider !== "mediasoup") return this.stopQualityGuard();
      void session.getTransportStats().then((reports) => {
        if (this.mediasoup !== session || !this.mediasoupConnected || this.msRecovering) return;
        const cur = countersFromStats(reports);
        const v = judgeQuality(prev, cur, { remoteMuted: this.s.remoteMuted });
        prev = cur;
        const a = this.netLadder.push(v);
        if (a.type === "none" && this.s.camOn) {
          // track the live estimate within the current rung (only re-apply on a >25 % move: no setParameters churn)
          const step = LADDER[this.netLadder.level];
          const vbps = videoBpsFor(step, v.outKbps);
          if (!lastVideoBps || Math.abs(vbps - lastVideoBps) / lastVideoBps > 0.25) {
            lastVideoBps = vbps;
            void session.applyLadderStep({ ...step, videoBps: vbps });
          }
        }
        if (a.type === "step") {
          lastVideoBps = videoBpsFor(a.step, v.outKbps);
          a.step = { ...a.step, videoBps: lastVideoBps };
          void this.diag("ladder", { level: a.level, dir: a.dir, loss: v.lossPercent ?? "", rtt: v.rttMs ?? "", outKbps: v.outKbps ?? "" });
          this.netLog("ladder", { level: a.level, dir: a.dir, audio: a.step.audioBps, loss: v.lossPercent, rtt: v.rttMs, outKbps: v.outKbps });
          w.__olNetLadder = { level: a.level, changes: [...(w.__olNetLadder?.changes ?? []), { t: Date.now(), level: a.level, dir: a.dir }] };
          void session.applyLadderStep(a.step);
        } else if (a.type === "tcp") {
          this.stopQualityGuard();
          this.netLog("ms-quality-fallback", { reasons: a.reasons.join(","), loss: v.lossPercent, rtt: v.rttMs, outKbps: v.outKbps, ladder: "floor" });
          void this.requestTcpFallback().finally(() => {
            // call 3ae8ff34: a short blip at the floor while the transport stayed connected made recovery a no-op, but the
            // ladder was already stopped → 16 kbps for the remaining 9 min. Still connected and not recovering: resume
            // the ladder (restarts at rung 1 and climbs on measured headroom, same as after any reconnect).
            if (this.mediasoup === session && this.mediasoupConnected && !this.msRecovering && this.busy && !this.qualityTimer && this.media?.provider === "mediasoup") this.startQualityGuard(session);
          });
        }
      }).catch(() => {});
    }, ADAPT.sampleMs);
  }

  /** Native apps only: Wi-Fi ⇄ cellular / new IP → fresh ICE in place on the UDP path (LiveKit restarts its own ICE). */
  private onNetworkChange = () => {
    if (!nativeAdaptiveEnabled() || !this.busy) return;
    this.netLog("net-change", { type: (navigator as unknown as { connection?: { type?: string } }).connection?.type ?? "" });
    if (this.media?.provider === "mediasoup") void this.mediasoup?.restartIceAll();
  };

  /**
   * Native apps only: make-before-break. Park the live path (room / UDP session, mic, remote audio) instead of tearing
   * it down; the new path connects alongside, and the parked one is released once the new path plays remote audio
   * (or after MBB_MAX_MS). Both sides switch together, so the old path keeps carrying audio during the handover.
   */
  static MBB_MAX_MS = 10_000;
  private parked: { release: () => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private parkMediaForSwitch() {
    this.releaseParked();
    const room = this.room, ms = this.mediasoup, mic = this.micTrack, cam = this.camTrack, els = this.audioEls, vp = this.micVoiceProcessing;
    if (!room && !ms) return;
    room?.removeAllListeners();
    this.room = null;
    this.mediasoup = null;
    this.micTrack = null;
    this.camTrack = null;
    this.audioEls = [];
    this.micVoiceProcessing = null;
    const release = () => {
      if (this.parked?.release !== release) return;
      clearTimeout(this.parked.timer);
      this.parked = null;
      if (room) void room.disconnect(true).catch(() => {});
      ms?.close();
      vp?.dispose();
      mic?.stop();
      cam?.stop();
      for (const el of els) el.remove();
    };
    this.parked = { release, timer: setTimeout(release, CallEngine.MBB_MAX_MS) };
  }
  private releaseParked() {
    this.parked?.release();
  }

  private stopQualityGuard() {
    if (this.qualityTimer) clearInterval(this.qualityTimer);
    this.qualityTimer = null;
  }

  private clearMediasoupDegrade() {
    if (this.mediasoupDegradeTimer) clearTimeout(this.mediasoupDegradeTimer);
    this.mediasoupDegradeTimer = null;
  }

  private async requestTcpFallback(skipSameSfu = false) {
    const callId = this.s.call?.id;
    if (!callId || this.fallbackInFlight || this.media?.provider !== "mediasoup") return;
    if (this.msRecoveryOnly()) {
      // this call's SFU media has worked: degrade on the SAME SFU (ICE-TCP), else keep recovering there — emergency
      // LiveKit is only for a call whose SFU media never connected (UDP and TCP both unreachable from the start)
      if (this.msRecovering) return;
      this.fallbackInFlight = true;
      let ok = false;
      try {
        // UDP-only (Donny, Oct 17): no ICE-TCP switch; recovery = ICE restart / UDP transport rebuild on the same SFU
        void skipSameSfu;
      } finally {
        this.fallbackInFlight = false;
      }
      if (ok) {
        this.udpRecovery.onUdpDrop(Date.now());
        this.startUdpRecovery();
      } else void this.recoverMediasoup("tcp-unavailable");
      return;
    }
    this.fallbackInFlight = true;
    this.udpRecovery.onUdpDrop(Date.now());
    this.startUdpRecovery();
    try {
      // 1) same SFU over ICE-TCP (no provider switch, peer unaffected); 2) only if that is unavailable, LiveKit
      // Main SFU only: no LiveKit jump. Recover on the same SFU (ICE restart → transport rebuild with backoff).
      this.netLog("ms-no-fallback-recover", { skipSameSfu });
      this.fallbackInFlight = false;
      void this.recoverMediasoup("tcp-unavailable");
      return;
    } catch {
      // The server keeps the call's normal reconnect grace; displaying the failure is preferable to a falsely active
      // call if both direct UDP and the durable TCP path are unavailable.
      this.set({ error: "Couldn't reconnect the call" });
      // Persistent: keep retrying the bridge with backoff for as long as the call is up.
      if (this.busy && !this.fallbackRetryTimer) {
        this.fallbackRetryTimer = setTimeout(() => {
          this.fallbackRetryTimer = null;
          void this.requestTcpFallback();
        }, this.udpRecovery.backoffMs());
      }
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
    if (this.media?.provider === "mediasoup") this.udpRecovery.onUdpDrop(Date.now());
    this.startUdpRecovery();
    void this.switchMedia(d.media, d.call);
  };

  /** Server moved both participants back to direct UDP (call:mediaRestore). */
  private onMediaRestore = (d: { call?: CallInfo; media?: CallMedia | null }) => {
    if (!d?.call || d.call.id !== this.s.call?.id || d.media?.provider !== "mediasoup" || this.s.ui !== "active") return;
    this.udpRecovery.onTrialStart(Date.now());
    void this.switchMedia(d.media, d.call);
  };

  private startUdpRecovery() {
    if (this.udpRecoveryTimer) return;
    this.udpRecoveryTimer = setInterval(() => this.udpRecoveryTick(), 2_000);
  }

  private stopUdpRecovery() {
    if (this.udpRecoveryTimer) clearInterval(this.udpRecoveryTimer);
    this.udpRecoveryTimer = null;
    if (this.fallbackRetryTimer) clearTimeout(this.fallbackRetryTimer);
    this.fallbackRetryTimer = null;
    this.udpRecovery.end();
    this.udpRecovery = new UdpRecoveryPolicy();
    this.restoreInFlight = false;
  }

  private udpRecoveryTick() {
    if (!this.busy || this.s.ui !== "active") return;
    const now = Date.now();
    const p = this.media?.provider;
    if (p === "livekit") {
      if (this.room?.state === "connected" && !this.s.reconnecting) this.udpRecovery.onTcpConnected(now);
      else this.udpRecovery.onTcpUnstable();
      // pinned (Oct 17): once a call is on LiveKit it stays there — no flapping back to the SFU mid-call
    } else if (p === "mediasoup" && this.msTcp) {
      if (this.mediasoupConnected && !this.s.reconnecting) this.udpRecovery.onTcpConnected(now);
      else this.udpRecovery.onTcpUnstable();
      if (this.udpRecovery.shouldTryUdp(now) && !this.restoreInFlight) void this.restoreMediasoupUdp();
    } else if (p === "mediasoup" && this.mediasoupConnected) {
      this.udpRecovery.tick(now);
    }
  }

  /** back from same-SFU TCP to UDP (make-before-break); a failed trial stays on TCP with backoff */
  private async restoreMediasoupUdp() {
    if (!this.media || this.media.provider !== "mediasoup") return;
    this.restoreInFlight = true;
    const media = this.media;
    try {
      this.udpRecovery.onTrialStart(Date.now());
      this.parkMediaForSwitch();
      this.dropMediaForRejoin();
      this.media = media;
      this.msTcp = false;
      this.netLog("media-restore-udp", { failures: this.udpRecovery.failures, from: "ms-tcp" });
      if (!(await this.connectMediasoup(media, true))) this.udpRecovery.onTrialRefused(Date.now());
    } finally {
      this.restoreInFlight = false;
    }
  }

  private async requestUdpRestore() {
    const callId = this.s.call?.id;
    if (!callId || this.restoreInFlight || this.media?.provider !== "livekit") return;
    this.restoreInFlight = true;
    try {
      const r = await this.req<{ ok: boolean; media?: CallMedia | null; call?: CallInfo; retryInMs?: number }>("call:mediaRestore", { callId }, 6_000);
      if (!r.ok || r.media?.provider !== "mediasoup") return void this.udpRecovery.onTrialRefused(Date.now(), r.retryInMs);
      this.udpRecovery.onTrialStart(Date.now());
      this.netLog("media-restore-udp", { failures: this.udpRecovery.failures });
      await this.switchMedia(r.media, r.call);
    } catch {
      this.udpRecovery.onTrialRefused(Date.now());
    } finally {
      this.restoreInFlight = false;
    }
  }

  private async switchMedia(media: CallMedia, call?: CallInfo) {
    if (!this.busy || this.media?.provider === media.provider && this.media.token === media.token) return;
    this.clearMediasoupDegrade();
    if (nativeAdaptiveEnabled()) this.parkMediaForSwitch();
    this.dropMediaForRejoin();
    this.media = media;
    this.roomPromise = null;
    if (call) this.set({ call });
    this.netLog(media.provider === "livekit" ? "media-fallback-livekit" : "media-restore-mediasoup");
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
          const onPlay = () => {
        this.releaseParked();
        this.firstAudio();
      };
          el.addEventListener("playing", onPlay, { once: true });
          document.addEventListener("visibilitychange", this.onVisibleCallAudio);
          // Explicit play(): WKWebView after a CallKit answer (no page gesture) can leave an autoplay <audio> paused
          // on audio-only calls (a video call has a playing <video> that unblocks the page's media).
          if (el.paused) void el.play().catch((e: unknown) => {
            this.diag("remote-audio-play-failed", { path: "livekit", err: String((e as Error)?.name ?? e).slice(0, 60), vis: document.visibilityState });
            this.set({ needsGesture: true });
          });
          else this.firstAudio();
        } else if (track.kind === Track.Kind.Video) {
          this.remoteVideo = track;
          this.startVideoResilience((track as unknown as { receiver?: RTCRtpReceiver }).receiver);
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

  // ---------- SFU outage recovery ----------
  static MS_RECOVER_GRACE_MS = 2_000;
  static MS_ICE_RESTART_WAITS = [0, 1500, 3000];
  static MS_REBUILD_DELAYS = [500, 1000, 2000, 3000, 5000, 8000];

  /** true once this call's SFU media has connected (or while recovering): outages stay on the SFU */
  private msRecoveryOnly() {
    return this.msRecovering || (!!this.msEverConnected && this.msEverConnected === this.s.call?.id);
  }

  private waitMsConnected(session: CallMediaSession, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    return new Promise((resolve) => {
      const tick = () => {
        if (this.mediasoup === session && this.mediasoupConnected) return resolve(true);
        if (this.mediasoup !== session || !this.busy || Date.now() >= until) return resolve(false);
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  /**
   * Total media loss after the call's SFU media had worked (all traffic blocked, tunnel, Wi-Fi drop): keep the call
   * and recover on the SFU — 1) fresh ICE on the live transports (cheap, keeps producers/consumers), 2) then rebuild
   * the transports with backoff + jitter for as long as the server keeps the call. UDP stays primary (the SFU offers
   * its ICE-TCP candidate alongside). Never falls into emergency LiveKit; ends only on hangup / server end.
   */
  private async recoverMediasoup(reason: string) {
    const callId = this.s.call?.id;
    if (this.msRecovering || this.rejoining || !this.busy || !callId || this.media?.provider !== "mediasoup") return;
    if (this.mediasoupConnected) return;
    this.msRecovering = true;
    const t0 = Date.now();
    const live = () => this.busy && this.s.call?.id === callId && this.media?.provider === "mediasoup";
    const done = (how: string, attempt: number) => {
      this.set({ reconnecting: false, error: null });
      if (this.mediasoup) {
        this.startUdpProbe(this.mediasoup);
        if (how === "ice") this.startQualityGuard(this.mediasoup);
      }
      this.netLog("ms-recovered", { how, attempt, ms: Date.now() - t0 });
    };
    this.stopQualityGuard();
    this.clearMediasoupDegrade();
    this.set({ reconnecting: true });
    this.netLog("ms-recover", { reason });
    try {
      const first = this.mediasoup;
      if (first) {
        for (const wait of CallEngine.MS_ICE_RESTART_WAITS) {
          if (wait) await new Promise((r) => setTimeout(r, wait));
          if (!live() || this.mediasoup !== first) break;
          if (this.mediasoupConnected) return done("ice", 0);
          this.netLog("ms-ice-restart");
          await first.restartIceAll().catch(() => {});
          if (await this.waitMsConnected(first, 2500)) return done("ice", 0);
        }
      }
      let attempt = 0;
      while (live()) {
        const g = await this.req<{ ok: boolean; call?: CallInfo; media?: CallMedia | null }>("call:get", { callId }, 4000).catch(() => null);
        if (!live()) return;
        if (g && (!g.ok || g.call?.phase === "ended")) {
          const call = g.call ?? this.s.call;
          if (call) this.finishLocal(g.call?.outcome ?? "completed", false, { ...call, phase: "ended" }, "connection_lost");
          return;
        }
        if (g?.ok && g.media && g.media.provider !== "mediasoup") {
          // the server moved this call (the peer's emergency fallback): follow it
          void this.switchMedia(g.media, g.call);
          return;
        }
        if (g?.ok && g.media) this.media = g.media;
        const media: CallMedia = this.media!;
        this.netLog("ms-rebuild", { attempt });
        this.dropMediaForRejoin();
        this.media = media;
        this.msTcp = false;
        const session = await this.connectMediasoup(media, true);
        if (session && this.mediasoup === session && this.mediasoupConnected) {
          if (g?.ok && g.call) this.set({ call: g.call });
          return done("rebuild", attempt);
        }
        if (Date.now() - t0 > CallEngine.MS_RECOVER_MAX_MS) {
          this.msRecovering = false;
          return void this.lastResortLiveKit("recover-timeout", `attempts=${attempt}`);
        }
        const base = CallEngine.MS_REBUILD_DELAYS[Math.min(attempt, CallEngine.MS_REBUILD_DELAYS.length - 1)];
        await new Promise((r) => setTimeout(r, base + Math.floor(Math.random() * Math.min(1000, base / 2))));
        attempt++;
      }
    } finally {
      this.msRecovering = false;
    }
  }

  // ---------- back to UDP (Donny: switch back automatically once UDP works) ----------
  private udpProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopUdpProbe() {
    if (this.udpProbeTimer) clearTimeout(this.udpProbeTimer);
    this.udpProbeTimer = null;
  }
  /** Landed on the SFU's ICE-TCP pair (UDP blocked at connect, or a recovery chose TCP): probe UDP with an in-place
   *  ICE restart on a backoff, never giving up while on TCP. The TCP pair carries audio until ICE nominates UDP, so
   *  the switch back has no teardown and no gap. Explicit tcpOnly transports (no UDP candidates) use udpRecovery. */
  private startUdpProbe(session: CallMediaSession, attempt = 0) {
    this.stopUdpProbe();
    if (this.msTcp) return;
    this.udpProbeTimer = setTimeout(async () => {
      this.udpProbeTimer = null;
      if (this.mediasoup !== session || !this.busy || this.media?.provider !== "mediasoup" || this.msTcp) return;
      if (!this.mediasoupConnected || this.msRecovering) return this.startUdpProbe(session, attempt);
      const reports = await session.getTransportStats().catch(() => [] as RTCStatsReport[]);
      if (this.mediasoup !== session) return;
      if (!anyOnTcp(reports as unknown as Parameters<typeof anyOnTcp>[0])) {
        if (attempt) this.netLog("udp-restored", { attempt });
        return;
      }
      this.netLog("udp-probe", { attempt });
      await session.restartIceAll().catch(() => {});
      this.startUdpProbe(session, attempt + 1);
    }, attempt === 0 ? 1_500 : udpProbeDelay(attempt - 1));
  }

  // ---------- reconnect ----------
  private rejoining = false;
  private wake: (() => void) | null = null;
  /** give up locally only when we can't even reach our server for this long (it ends the call after 45 s) */
  static LOCAL_GIVEUP_MS = 60_000;
  /** a call that was connected and dropped keeps recovering over UDP at most this long, then ends cleanly */
  static MS_RECOVER_MAX_MS = 45_000;
  static UDP_UNREACHABLE_MSG = "Can't connect the call on this network. Try another Wi-Fi or mobile data.";
  /** first-connect UDP retries before the last-resort LiveKit fallback (no more <0.5 s jumps) */
  /** WhatsApp-style first connect (Oct 17, 5:44): an instant early failure is not fatal; silent retries (no
   *  "Reconnecting…", the UI stays Calling/Connecting) within one ~5 s budget, then a silent LiveKit handover. */
  static FIRST_CONNECT_BUDGET_MS = 5_000;
  static FIRST_RETRY_GAP_MS = 400;
  /** push-woken / just-resumed callee (call d8d7eded, Oct 17): the first connect gets this long from the moment the
   *  signaling socket is back (or the app resumed), not 5 s from answer, before the LiveKit last resort. UI stays
   *  Calling/Connecting silently meanwhile. */
  static WOKEN_GRACE_MS = 12_000;
  static WAKE_WINDOW_MS = 30_000;
  /** a LiveKit last-resort join done by the native app gets its own budget (never the spent first-connect one) */
  static LIVEKIT_JOIN_BUDGET_MS = 15_000;
  private socketUpAt = 0;
  private resumedAt = 0;
  private resumeWatch = false;
  private firstConnectBudgetMs(): number {
    const t0 = this.firstConnectT0;
    const anchor = Math.max(this.socketUpAt, this.resumedAt);
    if (this.s.role !== "callee" || !t0 || !anchor || t0 - anchor > CallEngine.WAKE_WINDOW_MS) return CallEngine.FIRST_CONNECT_BUDGET_MS;
    return Math.max(CallEngine.FIRST_CONNECT_BUDGET_MS, anchor - t0 + CallEngine.WOKEN_GRACE_MS);
  }
  private firstConnectT0 = 0;
  private inFirstRetry = false;
  /**
   * Rejects when the first-connect budget runs out. A caller that connects while the call still rings starts the
   * clock at answer, not at dial (calls 2f8a9a3e / e5c02f6f: 5 s of ringing used the whole budget → instant fallback).
   */
  private async firstConnectBudget(): Promise<never> {
    const callId = this.s.call?.id;
    const ringing = () => this.busy && this.s.call?.id === callId && (this.s.call?.phase === "calling" || this.s.call?.phase === "ringing");
    if (ringing()) {
      while (ringing()) await new Promise((r) => setTimeout(r, 200));
      this.firstConnectT0 = Date.now();
    }
    let budget = Math.max(500, this.firstConnectBudgetMs() - (Date.now() - this.firstConnectT0));
    await new Promise((r) => setTimeout(r, budget));
    // the socket came back (or the app resumed) while waiting: extend to the woken grace instead of failing
    while ((budget = this.firstConnectBudgetMs() - (Date.now() - this.firstConnectT0)) > 0) await new Promise((r) => setTimeout(r, budget));
    throw new Error("first connect budget");
  }

  private async retryFirstConnect(reason: string) {
    if (this.inFirstRetry) return;
    const callId = this.s.call?.id;
    const live = () => this.busy && this.s.call?.id === callId && this.media?.provider === "mediasoup";
    this.inFirstRetry = true;
    try {
      let attempt = 0;
      while (Date.now() - this.firstConnectT0 < this.firstConnectBudgetMs() - CallEngine.FIRST_RETRY_GAP_MS) {
        await new Promise((r) => setTimeout(r, CallEngine.FIRST_RETRY_GAP_MS));
        if (!live()) return;
        attempt++;
        this.netLog("ms-first-retry", { attempt, reason });
        const media = this.media!;
        this.dropMediaForRejoin();
        this.media = media;
        const session = await this.connectMediasoup(media, true);
        if (session && this.mediasoup === session && this.mediasoupConnected) return;
      }
      if (live()) await this.lastResortLiveKit("first-connect", reason);
    } finally {
      this.inFirstRetry = false;
    }
  }

  /** Native media signalled a deterministic failure: Android drops to the WebView media path; iOS keeps its LiveKit backup. */
  private nativeFailed(reason: string) {
    if (nativeMediaIsAndroid()) return this.androidNativeToWebView(reason);
    return this.nativeLiveKitNow(reason);
  }

  /**
   * Android 0.3.18+ native media failed (first connect error/budget, or failed{fallback}): turn native media off for the
   * rest of this page session and reconnect the SAME call over the WebView media path (the path every Android call
   * used before). Its failure runs the normal WebView ladder (silent retries -> LiveKit -> clear message), never silence.
   */
  private nativeWebCall: string | null = null;
  private async androidNativeToWebView(reason: string) {
    const callId = this.s.call?.id;
    const media = this.media;
    if (!callId || !this.busy || this.nativeWebCall === callId || media?.provider !== "mediasoup") return;
    this.nativeWebCall = callId;
    disableAndroidNativeMedia(reason);
    this.diag("native-fallback-webview", { reason: reason.slice(0, 160) });
    // mid-call recovery loop already running: its next rebuild picks the WebView session (native is now off)
    if (this.msRecovering) return;
    this.dropMediaForRejoin();
    this.media = media;
    this.msEverConnected = null; // fresh first connect (own budget) on the WebView path
    await this.connectMediasoup(media, true);
  }

  /** Android app on the WebView media path: Phase A suspension hardening (heartbeat, stall detection, recovery ladder). */
  private lifecycle: AndroidCallLifecycle | null = null;
  private startAndroidLifecycle(session: CallMediaSession) {
    this.stopAndroidLifecycle();
    if (!isAndroidApp() || !(session instanceof MediasoupCallSession)) return;
    const lc = new AndroidCallLifecycle({
      audioEls: () => this.audioEls,
      audioContexts: () => { try { const c = audioContext(); return c ? [c] : []; } catch { return []; } },
      micTrack: () => (this.mediasoup === session ? session.micTrackForHealth() : null),
      recoverMic: () => session.recoverMic(),
      health: async () => summarizeStats(await session.getTransportStats()),
      restartIce: () => session.restartIceAll(),
      escalate: (reason) => {
        if (this.mediasoup !== session) return;
        this.netLog("lifecycle-escalate", { reason });
        this.onMediasoupState("failed");
      },
      busyRecovering: () => this.mediasoup !== session || this.msRecovering || this.rejoining || this.inFirstRetry || this.media?.provider !== "mediasoup",
      visible: () => typeof document === "undefined" || document.visibilityState === "visible",
      log: (ev, extra) => { this.diag(ev, extra); this.netLog(ev, extra); },
    });
    this.lifecycle = lc;
    lc.start();
  }
  private stopAndroidLifecycle() {
    this.lifecycle?.stop();
    this.lifecycle = null;
  }

  /** Android app native mediasoup failed: request LiveKit backup credentials now and hand the call over (once per call). */
  private nativeLkCall: string | null = null;
  private async nativeLiveKitNow(reason: string) {
    const callId = this.s.call?.id;
    if (!callId || !this.busy || this.nativeLkCall === callId || this.media?.provider !== "mediasoup") return;
    this.nativeLkCall = callId;
    await this.lastResortLiveKit("native-ms-failed", reason);
  }

  /** Last resort only after the mediasoup UDP retries truly failed: LiveKit. The clear message only if LiveKit fails too. */
  private async lastResortLiveKit(stage: string, reason = "") {
    const callId = this.s.call?.id;
    if (!callId || !this.busy) return;
    this.diag("ms-last-resort-livekit", { stage, reason: reason.slice(0, 160) });
    const r = await this.req<{ ok: boolean; media?: CallMedia | null; error?: string }>("call:mediaFallback", { callId }, 6_000).catch(() => null);
    if (!this.busy || this.s.call?.id !== callId) return;
    if (r?.ok && r.media?.provider === "livekit") {
      try {
        await this.switchMedia(r.media);
        this.set({ reconnecting: false, error: null });
        return;
      } catch {
        /* fall through to the clear message */
      }
    }
    this.failUdpUnreachable(stage, `livekit:${r?.error ?? "failed"}`);
  }

  /** End the attempt with the clear network message; the server's hangup notifies the other side. Logged via call:diag. */
  private failUdpUnreachable(stage: string, reason = "") {
    const call = this.s.call;
    if (!call || !this.busy) return;
    this.diag("udp-unreachable", { stage, reason: reason.slice(0, 160) });
    if (call.id) void this.req("call:hangup", { callId: call.id }).catch(() => {});
    postNative({ type: "call:ended", callId: call.id });
    this.teardownMedia();
    this.endWith(call, CallEngine.UDP_UNREACHABLE_MSG, false);
    this.set({ error: CallEngine.UDP_UNREACHABLE_MSG });
  }

  /** failure-reason telemetry to the server log (fire-and-forget; never affects the call) */
  private static DIAG_EVENTS = new Set(["ms-connect-failed", "ms-recover", "ms-recovered", "ms-rebuild", "ms-no-fallback-recover", "ms-quality-fallback", "ms-failed", "ms-disconnected", "still-reconnecting", "net-change"]);
  private diag(ev: string, extra: Record<string, unknown> = {}) {
    try {
      const callId = this.s.call?.id;
      if (!callId || !this.socket) return;
      const flat: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(extra)) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") flat[k] = v;
      const platform = nativePlatform() ?? "web";
      const nativeAudio = useNativeMedia(!!this.s.call?.video || this.s.camOn);
      this.socket.emit("call:diag", { callId, ev, role: this.s.role ?? "", ui: this.s.ui, platform, native: nativeAudio, ...flat });
    } catch {
      /* ignore */
    }
  }
  private netLog(ev: string, extra: Record<string, unknown> = {}) {
    if (CallEngine.DIAG_EVENTS.has(ev)) this.diag(ev, extra);
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
    this.stopAndroidLifecycle();
    this.stopQualityGuard();
    this.stopUdpProbe();
    this.mediasoupConnected = false;
    mediasoup?.close();
    this.mediasoupLocalVideo = null;
    this.mediasoupRemoteVideo = null;
    this.clearMediasoupDegrade();
    this.clearMicVoiceProcessing();
    void this.preMic?.then((t) => t?.stop());
    this.preMic = null;
    void this.tapMic?.then((t) => t?.stop());
    this.tapMic = null;
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
    if (this.rejoining || this.msRecovering) return; // one reconnect loop at a time: SFU recovery already retries
    const callId = this.s.call?.id;
    if (!callId) return;
    this.rejoining = true;
    const t0 = Date.now();
    this.set({ reconnecting: true });
    this.dropMediaForRejoin();
    const delays = [300, 1000, 2000, 3000, 5000, 8000];
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
        // Persistent reconnecting: never end the call on our own while it is still live on the server. Each pass
        // re-runs the ladder (connect → ICE/DTLS → same-SFU TCP → TURN-TLS/LiveKit on failure); the call ends only on a
        // hangup or when the server ends it (peer gone past its grace) — seen by call:get above.
        if (Date.now() - t0 > CallEngine.LOCAL_GIVEUP_MS && attempt % 10 === 0) this.netLog("still-reconnecting", { ms: Date.now() - t0, attempt });
        await new Promise<void>((r) => {
          const base = delays[Math.min(attempt, delays.length - 1)];
          const t = setTimeout(r, base + Math.floor(Math.random() * Math.min(1000, base / 2)));
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

  static PEER_OFFLINE_GRACE_MS = 15_000;
  private peerOfflineTimer: ReturnType<typeof setTimeout> | null = null;
  private onPeer = (d: { callId: string; userId: string; online: boolean }) => {
    if (!d || d.callId !== this.s.call?.id || d.userId === this.meId) return;
    this.netLog(d.online ? "peer-online" : "peer-offline");
    if (this.peerOfflineTimer) clearTimeout(this.peerOfflineTimer);
    this.peerOfflineTimer = null;
    if (d.online) return this.set({ peerReconnecting: false });
    // The peer's SIGNALLING socket dropped (iOS suspends a backgrounded/locked WebView's socket during a CallKit call)
    // but media is a separate path: while it still flows, don't flash "reconnecting" — re-check after a grace.
    if (!this.mediaConnected()) return this.set({ peerReconnecting: true });
    this.peerOfflineTimer = setTimeout(() => {
      this.peerOfflineTimer = null;
      if (this.busy && !this.mediaConnected()) this.set({ peerReconnecting: true });
    }, CallEngine.PEER_OFFLINE_GRACE_MS);
  };

  private netWatched = false;
  private lastNetType: string | null = null;
  private lastNetworkTier: NetworkTier = "normal";
  private netTimer: ReturnType<typeof setTimeout> | null = null;
  /** Network changes (Wi-Fi ↔ cellular, IP change, offline/online): refresh the media path right away instead of
   *  waiting for ICE consent to time out. LiveKit resumes with an ICE restart; if it has given up, we rejoin. */
  private nativeAudioWatched = false;
  private watchNativeAudio() {
    if (this.nativeAudioWatched || typeof window === "undefined") return;
    this.nativeAudioWatched = true;
    // iOS wrapper: CallKit (de)activated the AVAudioSession → replay remote voice WebKit paused on the swap.
    window.addEventListener("openlounge:native-audio-resume", (e) => {
      if (this.audioEls.length) void resumePausedCallAudio(this.audioEls).then((blocked) => blocked && this.set({ needsGesture: true }));
      const reason = String((e as CustomEvent<{ reason?: string }>).detail?.reason ?? "");
      if (this.busy && this.s.role === "caller" && MIC_HANDOVER_REASONS.has(reason)) {
        // Caller: the mic + send transport + producer were built while ringing (before CallKit owned the session).
        // The session just changed hands → flip a fresh capture onto the existing producer right away.
        if (this.mediasoup) this.mediasoup.rebindMic();
        else this.micHandoverPending = true;
        return;
      }
      // ...and the outbound mic: an outgoing call captured it before CallKit took the session (muted → silence)
      this.mediasoup?.checkMicAlive();
    });
  }

  private watchNetwork() {
    if (this.netWatched || typeof window === "undefined") return;
    this.netWatched = true;
    this.watchNativeAudio();
    const conn = (navigator as unknown as { connection?: EventTarget & { type?: string; effectiveType?: string } }).connection;
    this.lastNetType = conn?.type ?? null;
    this.lastNetworkTier = browserNetworkTier();
    const refresh = (why: string) => {
      if (this.netTimer) clearTimeout(this.netTimer);
      this.netTimer = setTimeout(() => {
        if (!this.busy || (this.s.ui !== "active" && this.s.ui !== "connecting")) return;
        this.netLog("net-change", { why });
        const room = this.room;
        if (this.mediasoup && nativeAdaptiveEnabled()) {
          // Native apps: UDP stays persistent across Wi-Fi ⇄ cellular — fresh ICE in place on the new interface.
          // If it doesn't reconnect, the existing disconnected-grace timer still moves the call to TCP.
          this.onNetworkChange();
        } else if (this.mediasoup) {
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
    // Wrappers call this from their OS path monitor (iOS NWPathMonitor via expo-network, Android ConnectivityManager)
    // because WebViews don't fire navigator.connection "change" reliably on an interface handoff.
    (window as unknown as { __olNetworkChanged?: (type?: string) => void }).__olNetworkChanged = (type?: string) => {
      if (!nativeAdaptiveEnabled()) return;
      if (type && type === this.lastNetType) return;
      this.lastNetType = type ?? null;
      refresh(`native:${type ?? "?"}`);
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
    this.diag("first-audio", { ms });
  }

  /** First connect of a web-path (mediasoup) call: offer the Speaker toggle (it was only detected on LiveKit, so
   *  Android/iOS app calls had none) and set the default route — video calls on speaker, voice on earpiece. */
  private initCallRoute() {
    const callId = this.s.call?.id;
    const speaker = !!(this.s.camOn || this.s.call?.video);
    this.set({ speaker });
    postNative({ type: "call:audioRoute", speaker });
    this.startLevelTelemetry();
    void this.detectSpeaker().then((speakerSupported) => {
      if (this.s.call?.id !== callId) return;
      this.set({ speakerSupported });
      const id = speaker ? this.sinkIds[1] : undefined;
      if (id) for (const el of this.audioEls) void (el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(id).catch(() => {});
    });
  }

  /** audio-level telemetry (Donny, 6:22): every 5 s while the call runs, log-only via call:diag */
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private lastAudioBytes = { out: 0, in: 0, t: 0 };
  private startLevelTelemetry() {
    if (this.levelTimer) clearInterval(this.levelTimer);
    const callId = this.s.call?.id;
    this.lastAudioBytes = { out: 0, in: 0, t: 0 };
    this.levelTimer = setInterval(() => void (async () => {
      if (!this.busy || this.s.call?.id !== callId) {
        if (this.levelTimer) clearInterval(this.levelTimer);
        this.levelTimer = null;
        return;
      }
      const sess = this.mediasoup as unknown as { getTransportStats?: () => Promise<RTCStatsReport[]> } | null;
      const reports = (await sess?.getTransportStats?.().catch(() => [])) ?? [];
      const r: Record<string, string | number> = {};
      let outB = 0, inB = 0;
      const n3 = (x: unknown) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : "");
      for (const rep of reports) rep.forEach((st: Record<string, unknown>) => {
        if (st.kind !== "audio") return;
        if (st.type === "media-source") { r.micLevel = n3(st.audioLevel); r.micEnergy = n3(st.totalAudioEnergy); }
        else if (st.type === "outbound-rtp") outB += Number(st.bytesSent ?? 0);
        else if (st.type === "inbound-rtp") {
          inB += Number(st.bytesReceived ?? 0);
          r.inLevel = n3(st.audioLevel);
          r.inEnergy = n3(st.totalAudioEnergy);
          const tot = Number(st.totalSamplesReceived ?? 0);
          r.concealPct = tot ? Math.round((Number(st.concealedSamples ?? 0) / tot) * 1000) / 10 : "";
        }
      });
      const now = Date.now(), dt = (now - this.lastAudioBytes.t) / 1000;
      if (this.lastAudioBytes.t && dt > 0) {
        r.outKbps = Math.round(((outB - this.lastAudioBytes.out) * 8) / dt / 100) / 10;
        r.inKbps = Math.round(((inB - this.lastAudioBytes.in) * 8) / dt / 100) / 10;
      }
      this.lastAudioBytes = { out: outB, in: inB, t: now };
      const el = this.audioEls[0];
      const w = window as unknown as { __olNativeCalls?: unknown };
      this.diag("audio-levels", {
        ...r,
        route: this.s.speaker ? "speaker" : "earpiece",
        vol: el ? el.volume : "",
        muted: el ? String(el.muted) : "",
        paused: el ? String(el.paused) : "",
        plat: /Android/i.test(navigator.userAgent) ? "android" : /iPhone|iPad/i.test(navigator.userAgent) ? "ios" : "web",
        // app = running inside the iOS/Android wrapper; the top-level native flag (set by diag) is whether the app
        // owns call media (nativeAudio). This key used to be "native" and overwrote it (85a16932: WebView path read native=true).
        app: String(!!w.__olNativeCalls),
        nativeAudio: String(!!this.s.nativeAudio),
      });
    })(), 5_000);
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
    this.msTcp = false;
    this.releaseParked();
    const room = this.room;
    this.room = null;
    this.roomPromise = null;
    if (room) {
      room.removeAllListeners();
      void room.disconnect();
    }
    const mediasoup = this.mediasoup;
    this.mediasoup = null;
    this.stopAndroidLifecycle();
    this.stopQualityGuard();
    this.stopUdpProbe();
    this.mediasoupConnected = false;
    mediasoup?.close();
    this.mediasoupLocalVideo = null;
    this.mediasoupRemoteVideo = null;
    this.clearMediasoupDegrade();
    this.clearMicVoiceProcessing();
    void this.preMic?.then((t) => t?.stop());
    this.preMic = null;
    void this.tapMic?.then((t) => t?.stop());
    this.tapMic = null;
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
    this.stopUdpRecovery();
    this.stopVideoResilience?.();
    this.stopVideoResilience = null;
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
