// Client call engine: one per app. Owns the call state machine on this device and its one media session.
// Media (RingRTC hard cut): a single 1:1 P2P WebRTC PeerConnection whose signaling is E2E-sealed (OLX3DH-v1, rc:msg).
//  - browsers / older app builds: CallSession (src/lib/calls/rtc) in this page, audio + optional camera on one PC;
//  - apps with the rtcP2P capability: the app owns mic/camera/PC (iOS OLRtcCall, Android RtcCallSession); this page
//    relays rc:* / rtc:* only (NativeMediaSession). There is no SFU, LiveKit or fallback lane for calls.
import { isHeadsetKind, routeAnnouncement, routeFromNative, routesFromNative, routesFromWebOutputs, sortRoutes, type AudioRoute, type NativeRouteDetail } from "./audioRoute";
import { nextElsewhere } from "./elsewhere";
import type { ElsewhereCall } from "./elsewhere";
import type { CallInfo, CallMedia, CallOutcome } from "@/lib/types";
import type { RealtimeClient } from "@/lib/realtime";
import { native, nativePlatform } from "@/lib/native";
import { unlockAudio } from "@/lib/audioUnlock";
import { nativeRingbackMode, playBusy, playConnected, playHangup, playRingback, playRingtone, rearmRing, ringing, stopTones } from "./tones";
import { CallSession } from "./rtc/CallSession";
import { ensureRcKeysPublished, sealedFor } from "./ringrtc";
import type { CallFailure } from "./rtc/CallFailures";
import { NativeMediaSession, nativeMediaCmd, useNativeMedia } from "./nativeMediaSession";
import { CallTelemetry } from "./callTelemetry";
import { swapVideoTrack } from "./frameHold";

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
  /** where call audio plays right now (Speaker / Phone / Headphones / AirPods …); null until known */
  route: AudioRoute | null;
  /** outputs the user can pick from (picker sheet); [] = none known */
  routes: AudioRoute[];
  /** false = this browser cannot switch outputs (iOS Safari, Firefox): the button explains instead of switching */
  routeSwitchable: boolean;
  /** short "Audio on AirPods" announcement after an automatic route change (device connected/removed) */
  routeNotice: string | null;
  quality: Quality;
  reconnecting: boolean;
  /** the other person lost their connection (server call:peer / LiveKit): "Bea is reconnecting…" */
  peerReconnecting: boolean;
  connectedAt: number | null;
  endedText: string | null;
  /** ended because of busy / no answer → offer "Call again" */
  canRetry: boolean;
  /** a connected video call just ended normally: the overlay holds the last frame and fades out quickly instead of
   *  switching to the audio-style "Call ended" screen (retry/lost screens are unaffected) */
  endedVideo: boolean;
  error: string | null;
  needsGesture: boolean;
  /** "Bea turned on video" prompt (offer to turn on mine) */
  videoInvite: boolean;
  /** app call uses app-owned media; audio-only native calls retain their prior no-upgrade control policy */
  nativeAudio: boolean;
  /** explicit caller-only iPhone native video grant; keeps the existing camera toggle/flip UI available */
  nativeVideo: boolean;
  /** the same account is in a call on ANOTHER device (display-only pill; never rings or takes audio here) */
  elsewhere: ElsewhereCall | null;
  v: number;
}

const ENDED_LINGER_MS = 1800;
/** Connected video call → the call screen fades out at once (200 ms, opacity only; no held frame, no "Call ended" card), then unmounts. */
export const ENDED_VIDEO_LINGER_MS = 240;
/** dispatched on attached call <video> elements right before an ended video call tears media down (frameHold freezes) */
export const CALL_FREEZE_EVENT = "olcall:freeze";

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
  route: null,
  routes: [],
  routeSwitchable: false,
  routeNotice: null,
  quality: "unknown",
  reconnecting: false,
  peerReconnecting: false,
  connectedAt: null,
  endedText: null,
  canRetry: false,
  endedVideo: false,
  error: null,
  needsGesture: false,
  videoInvite: false,
  nativeAudio: false,
  nativeVideo: false,
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
/** App routes when the wrapper sends no list (iOS build ≤61, Android ≤0.3.19): Phone + Speaker, plus the current device. */
function nativeBuiltins(current: AudioRoute | null, known: AudioRoute[] = []): AudioRoute[] {
  const base: AudioRoute[] = [{ id: "earpiece", kind: "earpiece", name: "" }, { id: "speaker", kind: "speaker", name: "" }];
  const devices = known.filter((r) => isHeadsetKind(r.kind));
  return sortRoutes([...base, ...devices, ...(current ? [current] : [])]);
}

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
  private audioEls: HTMLMediaElement[] = [];
  /** Each visible feed has a native-aspect foreground plus a blurred duplicate fill. */
  private videoEls = { local: [] as HTMLVideoElement[], remote: [] as HTMLVideoElement[] };
  private acceptedHere = false;
  private acceptT0 = 0;
  /** outgoing native-media call: media join held until answer so the native ringback stays loud (iOS) */
  private deferNativeConnect = false;
  private metricSent = false;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private weakTimer: ReturnType<typeof setTimeout> | null = null;
  /** web: the audiooutput deviceId the user picked ("" = follow the system default) */
  private webSinkId = "";
  /** the user picked a route by hand this call: device changes still auto-switch, but never silently undo the pick */
  private routeUserPick = false;
  private routeNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private stopWebRouteWatch: (() => void) | null = null;
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
  /** Still reconnecting 20 s later while the network is up → rebuild the one media session. */
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
  /** Socket (re)connected during a call — e.g. the WebView resumed after the iPhone call screen took over a push-woken
   *  answer: re-bind this connection to the call right away, adopt the server's state, and if media never came up
   *  (or dropped) once the first-connect budget is spent, rebuild it instead of sitting silent. */
  private onSocketBack = () => {
    const call = this.s.call;
    if (!call || !this.busy) return;
    this.diag("socket-back", { media: this.mediaConnected() });
    void this.req<{ ok: boolean; call?: CallInfo }>("call:get", { callId: call.id }, 5_000)
      .then((r) => {
        if (r?.call && this.s.call?.id === call.id) this.onState({ call: r.call });
        if (!this.busy || this.s.call?.id !== call.id) return;
        if (this.s.ui !== "active" && this.s.ui !== "connecting") return;
        if (this.deferNativeConnect || this.mediaConnected() || this.rejoining) return;
        if (!this.rtc && !this.native) void this.rejoin("socket-back");
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
      this.socket.off("connect", this.onSocketBack);
    }
    this.socket = socket;
    if (!socket) return;
    void ensureRcKeysPublished(socket);
    socket.on("call:incoming", this.onIncoming);
    socket.on("call:state", this.onState);
    socket.on("call:video", this.onVideo);
    socket.on("call:peer", this.onPeer);
    socket.on("connect", this.onSocketBack);
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
        r = await this.req("call:start", { peerId, video, platform: nativePlatform() ?? "web" }, Math.max(1_000, Math.min(10_000, until - Date.now())));
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
      if (this.s.call?.id === call.id && (this.rtc || this.native)) {
        // WS came back while media kept going: just re-sync the peer's state
        this.set({ peerReconnecting: !!call.offline?.some((u) => u !== this.meId) });
        return;
      }
      if (this.s.call?.id === call.id && call.phase === "active" && this.s.connectedAt) {
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
    // Native app: the app owns media. iOS defers its media join to the answer so the native ringback stays loud.
    // Browser: mic (and camera) permission prompt happens now, inside the tap, in parallel with the server round trip.
    this.deferNativeConnect = useNativeMedia() && nativeRingbackMode() !== "off" && nativePlatform() === "ios";
    if (!useNativeMedia() && video) void this.ensureCamPreview().then(() => this.s.ui === "outgoing" && rearmRing());
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
      this.ringStop("glare");
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
    this.diag("ring-start", { tone: "ringback" });
    this.media = r.media ?? null;
    this.set({ call: r.call });
    if (!this.media) {
      this.set({ error: "Calls aren't available right now" });
      void this.hangup();
      return { ok: false };
    }
    postNative({ type: "call:outgoing", callId: r.call.id, name: peer.name, video, nativeMedia: useNativeMedia() });
    this.diag("call-start", { video, app: appVersionFromUa() });
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
    this.diag("ring-start", { tone: "ringtone" });
    mark("ring");
  };

  async accept(withVideo = false) {
    const call = this.s.call;
    if (!call || this.s.ui !== "incoming") return;
    unlockAudio();
    this.ringStop("accept");
    stopTones();
    buzz("medium");
    this.acceptT0 = performance.now();
    mark("accept");
    this.acceptedHere = true;
    rememberAccepted(call.id);
    this.set({ ui: "connecting", camOn: withVideo, error: null });
    this.diag("answered", {});
    // iOS build 72+: CallKit is answered at the tap (stops the system ring now, not at media connect). Older apps ignore it.
    postNative({ type: "call:answering", callId: call.id, video: !!(withVideo || call.video) });
    if (useNativeMedia()) void nativeMediaCmd({ op: "prewarm" }).catch(() => {});
    else if (withVideo) void this.ensureCamPreview();
    // connect with the ring-time token right away, in parallel with telling the server
    const accepted = this.req<{ ok: boolean; call?: CallInfo; media?: CallMedia | null; error?: string }>("call:accept", { callId: call.id, platform: nativePlatform() ?? "web" }).catch(() => ({ ok: false, error: "No connection" }) as const);
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
    this.ringStop("decline");
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
        this.ringStop("answered-elsewhere");
        stopTones();
        postNative({ type: "call:ended", callId: call.id, reason: "answered_elsewhere" });
        this.teardownMedia();
        this.set({ ...initial(), elsewhere: nextElsewhere(this.s.elsewhere, call, this.meId, false), v: this.s.v + 1 });
        return;
      }
      if (role === "caller" && this.s.ui === "outgoing") {
        this.ringStop("accept");
        stopTones();
        this.acceptT0 = performance.now();
        mark("accepted");
        this.set({ call, ui: this.mediaConnected() ? "active" : "connecting", connectedAt: Date.now() });
        if (this.mediaConnected()) playConnected();
        postNative({ type: "call:connected", callId: call.id, video: !!call.video });
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
    this.ringStop(outcome === "cancelled" || outcome === "missed" ? "cancel" : "end");
    stopTones();
    this.teardownMedia();
    // a call answered early in CallKit (iOS b72) whose media never came up ends as failed, not as a normal hang-up
    postNative({ type: "call:ended", callId: call.id, ...(outcome === "failed" ? { reason: "failed" } : {}) });
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
    const endedVideo = !canRetry && !!this.s.connectedAt && (this.s.ui === "active" || this.s.ui === "connecting") && (!!call.video || this.s.camOn || this.s.remoteCam);
    // hold the last decoded frame on every call tile before teardown stops the tracks (a locally stopped track fires
    // no "ended" event, so frameHold would otherwise paint one black frame before its watchdog notices)
    if (endedVideo) for (const el of [...this.videoEls.remote, ...this.videoEls.local]) try { el.dispatchEvent(new Event(CALL_FREEZE_EVENT)); } catch { /* non-DOM */ }
    this.teardownMedia();
    this.set({ call: { ...call, phase: "ended" }, ui: "ended", endedText: text, canRetry, endedVideo, minimized: endedVideo && this.s.minimized, reconnecting: false });
    this.endTimer = setTimeout(() => this.set({ ...initial(), v: this.s.v + 1 }), canRetry ? 6000 : endedVideo ? ENDED_VIDEO_LINGER_MS : ENDED_LINGER_MS);
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

  // ---------- media (one path: CallSession over sealed rc:* or the app-owned native PC) ----------
  private rtc: CallSession | null = null;
  private native: NativeMediaSession | null = null;
  private nativeConnected = false;
  private roomPromise: Promise<null> | null = null;
  private camTrack: MediaStreamTrack | null = null;
  private remoteVideo: MediaStreamTrack | null = null;
  private flippingCamera = false;
  private telemetry: CallTelemetry | null = null;

  private mediaConnected() {
    return this.rtc?.state === "media-running" || this.rtc?.state === "recovering" || this.nativeConnected;
  }

  private async ensureCamPreview(): Promise<MediaStreamTrack | null> {
    if (useNativeMedia()) return null; // the app owns the camera
    if (this.camTrack) return this.camTrack;
    try {
      const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: this.s.facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
      const t = st.getVideoTracks()[0] ?? null;
      if (!t || !this.busy) {
        t?.stop();
        return null;
      }
      this.camTrack = t;
      this.logCameraTrack(t, "capture");
      this.attachRawVideo(this.videoEls.local, t);
      this.set({ camOn: true });
      return t;
    } catch {
      this.set({ camOn: false, error: "Camera unavailable. Continuing with audio." });
      return null;
    }
  }

  private onConnected(answer: boolean) {
    this.set({ reconnecting: false });
    this.firstAudio();
    if (!this.routeInit) {
      this.routeInit = true;
      this.initCallRoute();
    }
    if ((answer || this.s.call?.phase === "active") && this.s.ui === "connecting") {
      this.set({ ui: "active", connectedAt: this.s.connectedAt ?? Date.now() });
      playConnected();
      postNative({ type: "call:connected", callId: this.s.call?.id, video: !!(this.s.camOn || this.s.call?.video) });
    }
  }
  private routeInit = false;

  /** Join the call's media. P2P is the only provider; the native app owns media when it implements rtcP2P. */
  private connect(answer: boolean): Promise<null> {
    if (this.roomPromise) return this.roomPromise;
    const media = this.media;
    if (!media) return Promise.resolve(null);
    this.roomPromise = useNativeMedia() ? this.connectNative(media, answer) : this.connectP2P(media, answer);
    return this.roomPromise;
  }

  private async connectNative(media: CallMedia, answer: boolean): Promise<null> {
    const call = this.s.call;
    if (!call?.id || !this.socket) return null;
    const session = new NativeMediaSession(this.socket, media, {
      callId: call.id,
      caller: this.s.role === "caller",
      onState: (st) => {
        if (this.native !== session) return;
        if (st === "connected") {
          this.nativeConnected = true;
          this.onConnected(answer);
        } else this.set({ reconnecting: true });
      },
      onRemoteVideo: (on) => { if (this.native === session) this.set({ remoteCam: on, videoInvite: on && !this.s.camOn }); },
      onCameraUnavailable: () => { if (this.native === session) this.set({ camOn: false, error: "Camera unavailable. Continuing with audio." }); },
    });
    this.native = session;
    this.set({ nativeAudio: true, nativeVideo: true });
    try {
      await session.connect(this.s.camOn || !!call.video);
      if (this.native !== session || !this.busy) return null;
      if (this.s.muted) void session.setMuted(true);
      this.nativeConnected = true;
      this.startTelemetry(() => session.stats());
      this.onConnected(answer);
    } catch (e) {
      if (this.native === session && this.busy) {
        this.netLog("native-connect-failed", { reason: String((e as Error)?.message ?? e).slice(0, 160) });
        this.set({ error: "Couldn't connect the call" });
        void this.hangup();
      }
    }
    return null;
  }

  private async connectP2P(media: CallMedia, answer: boolean): Promise<null> {
    const call = this.s.call;
    if (!call?.id || !this.socket) return null;
    const role = this.s.role === "caller" ? "caller" : "callee";
    // RingRTC session model: all call signaling E2E-sealed (OLX3DH-v1) and relayed opaquely as rc:msg.
    const peerUserId = call.callerId === this.meId ? call.calleeId : call.callerId;
    const sealed = sealedFor(this.socket, { callId: call.id, role, peerUserId, log: (ev, d) => this.netLog(ev, d ?? {}) });
    const session = new CallSession(sealed, {
      callId: call.id,
      role,
      media,
      video: this.s.camOn || !!call.video,
      log: (ev, d) => this.netLog(`rtc-${ev}`, d ?? {}),
      onRemoteTrack: (t) => {
        if (this.rtc !== session || t.kind !== "video") return;
        this.remoteVideo = t;
        this.attachRawVideo(this.videoEls.remote, t);
      },
      onPhase: (p) => {
        if (this.rtc !== session) return;
        if (p === "recovering") this.set({ reconnecting: true });
        if (p === "media-running") this.onConnected(answer);
      },
      onFailure: (f: CallFailure) => {
        if (this.rtc !== session) return;
        this.netLog("rtc-failure", { kind: f.kind, code: f.code, local: f.local });
        this.diag("rtc-failure", { kind: f.kind, code: f.code });
        if (f.kind === "network" && f.code === "recovery-exhausted" && this.busy) void this.hangup();
      },
    });
    this.rtc = session;
    if (this.s.muted) session.setMuted(true);
    const startP = session.start();
    if (this.s.camOn) void this.ensureCamPreview().then(async (t) => { if (t && this.rtc === session) await session.setVideoTrack(t); }).catch(() => {});
    this.startTelemetry(() => session.stats());
    try {
      await startP;
    } catch (e) {
      const f = e as CallFailure;
      if (this.rtc === session && this.busy) {
        this.netLog("rtc-start-failed", { kind: f?.kind, code: f?.code });
        if (f?.kind === "permission") this.set({ error: "Allow microphone access to make calls" });
        else if (f?.kind !== "session") this.set({ error: "Couldn't connect the call" });
        if (f?.kind !== "session") void this.hangup();
      }
    }
    return null;
  }

  private attachRawVideo(els: readonly HTMLVideoElement[], track: MediaStreamTrack | null) {
    // #49: swap the track inside the element's existing MediaStream (never clear srcObject mid-call: no black flash)
    for (const el of els) swapVideoTrack(el, track);
  }

  private startTelemetry(stats: () => Promise<RTCStatsReport[]>) {
    const callId = this.s.call?.id;
    if (!callId) return;
    this.telemetry?.stop();
    this.telemetry = new CallTelemetry({
      callId, platform: nativePlatform() ?? "web",
      stats,
      net: () => (navigator as unknown as { connection?: { type?: string; effectiveType?: string } }).connection?.type,
      send: (payload) => { try { this.socket?.emit("call:telemetry", payload); } catch { /* ignore */ } },
    });
    this.telemetry.start();
  }

  /** Socket/WS came back but media never came up (or the session closed): rebuild the one session once. */
  private rejoining = false;
  private async rejoin(reason: string) {
    if (this.rejoining || !this.busy) return;
    this.rejoining = true;
    this.netLog("rejoin", { reason });
    try {
      this.dropMedia();
      await this.connect(true);
    } finally {
      this.rejoining = false;
    }
  }

  private dropMedia() {
    this.telemetry?.stop();
    this.telemetry = null;
    this.rtc?.close();
    this.rtc = null;
    this.native?.close();
    this.native = null;
    this.nativeConnected = false;
    this.roomPromise = null;
  }

  private peerOfflineTimer: ReturnType<typeof setTimeout> | null = null;
  static PEER_OFFLINE_GRACE_MS = 15_000;
  private onPeer = (d: { callId: string; userId: string; online: boolean }) => {
    if (!d || d.callId !== this.s.call?.id || d.userId === this.meId) return;
    this.netLog(d.online ? "peer-online" : "peer-offline");
    if (this.peerOfflineTimer) clearTimeout(this.peerOfflineTimer);
    this.peerOfflineTimer = null;
    if (d.online) return this.set({ peerReconnecting: false });
    if (!this.mediaConnected()) return this.set({ peerReconnecting: true });
    this.peerOfflineTimer = setTimeout(() => {
      this.peerOfflineTimer = null;
      if (this.busy && !this.mediaConnected()) this.set({ peerReconnecting: true });
    }, CallEngine.PEER_OFFLINE_GRACE_MS);
  };

  private netWatched = false;
  private nativeAudioWatched = false;
  private watchNativeAudio() {
    if (this.nativeAudioWatched || typeof window === "undefined") return;
    this.nativeAudioWatched = true;
    // App reports the route it actually chose (speaker / earpiece / headset / Bluetooth / car).
    window.addEventListener("openlounge:native-audio-route", (e) => this.onNativeRoute((e as CustomEvent<NativeRouteDetail>).detail));
  }

  /** Network changes: CallSession's NetworkRecovery owns ICE restarts (window "online"); native apps restart ICE themselves. */
  private watchNetwork() {
    if (this.netWatched || typeof window === "undefined") return;
    this.netWatched = true;
    this.watchNativeAudio();
    (window as unknown as { __olNetworkChanged?: (type?: string) => void }).__olNetworkChanged = (type?: string) => {
      this.netLog("net-change", { why: `native:${type ?? "?"}` });
      if (this.native) void this.native.restartIce();
    };
    window.addEventListener("offline", () => {
      if (this.busy && this.s.ui === "active") this.set({ reconnecting: true });
      this.netLog("offline");
    });
    window.addEventListener("online", () => {
      this.netLog("online");
      if (this.busy && this.mediaConnected()) this.set({ reconnecting: false });
    });
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

  private ringStop(reason: string) {
    const tone = ringing();
    if (tone) this.diag("ring-stop", { tone, reason });
  }
  private diag(ev: string, extra: Record<string, unknown> = {}) {
    try {
      const callId = this.s.call?.id;
      if (!callId || !this.socket) return;
      const flat: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(extra)) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") flat[k] = v;
      this.socket.emit("call:diag", { callId, ev, role: this.s.role ?? "", ui: this.s.ui, platform: nativePlatform() ?? "web", native: useNativeMedia(), ...flat });
    } catch {
      /* ignore */
    }
  }
  private static DIAG_EVENTS = new Set(["rejoin", "net-change", "native-connect-failed", "rtc-start-failed"]);
  private netLog(ev: string, extra: Record<string, unknown> = {}) {
    if (CallEngine.DIAG_EVENTS.has(ev)) this.diag(ev, extra);
    try {
      const w = window as unknown as { __olCallNet?: { ev: string; t: number }[] };
      (w.__olCallNet ??= []).push({ ev, t: Date.now(), ...extra });
    } catch {
      /* ignore */
    }
  }
  private logCameraTrack(track: MediaStreamTrack, source: string) {
    try {
      const st = track.getSettings?.();
      this.netLog("camera-track", { source, width: st?.width, height: st?.height });
    } catch {
      this.netLog("camera-track", { source });
    }
  }

  private setQuality(qy: Quality) {
    if (this.weakTimer) clearTimeout(this.weakTimer);
    if (qy === "poor" || qy === "lost") this.weakTimer = setTimeout(() => this.set({ quality: qy }), 2000);
    else this.set({ quality: qy });
  }

  /** First connect: offer the Speaker toggle and set the default route — video calls on speaker, voice on earpiece. */
  private routeReasserted = false;

  private initCallRoute() {
    const callId = this.s.call?.id;
    const video = !!(this.s.camOn || this.s.call?.video);
    this.routeUserPick = false;
    if (this.inApp()) {
      // Default: video → Speaker, voice → Phone (earpiece). A connected headset/Bluetooth device always wins — the app
      // keeps it and reports the real route back (openlounge:native-audio-route), which replaces this first guess.
      const guess: AudioRoute = video ? { id: "speaker", kind: "speaker", name: "" } : { id: "earpiece", kind: "earpiece", name: "" };
      const keep = this.s.route && isHeadsetKind(this.s.route.kind) ? this.s.route : null;
      this.set({ speaker: !keep && video, speakerSupported: true, routeSwitchable: true, route: keep ?? guess, routes: this.s.routes.length ? this.s.routes : nativeBuiltins(keep) });
      postNative({ type: "call:audioRoute", speaker: video, route: video ? "speaker" : "earpiece", auto: true });
      this.routeReasserted = false;
      this.diag("route init", { route: keep?.kind ?? guess.kind, video, camOn: !!this.s.camOn, callVideo: !!this.s.call?.video, kept: !!keep });
      return;
    }
    // Web: audio follows the system output (a plugged/paired headset already wins there); list the outputs so the
    // button names the real device, and offer a picker where the browser can switch (setSinkId).
    void this.refreshWebRoutes(false).then(() => {
      if (this.s.call?.id !== callId) return;
      this.watchWebRoutes();
    });
  }

  private inApp() {
    return typeof window !== "undefined" && !!(window as unknown as { __olNativeCalls?: unknown }).__olNativeCalls;
  }

  private announceRoute(text: string | null) {
    if (this.routeNoticeTimer) clearTimeout(this.routeNoticeTimer);
    this.routeNoticeTimer = null;
    if (!text) return;
    this.set({ routeNotice: text });
    this.routeNoticeTimer = setTimeout(() => this.s.routeNotice && this.set({ routeNotice: null }), 3_000);
  }

  /** App (iOS/Android) reported the route it actually uses (after our command, or a device connect/remove). */
  private onNativeRoute(d: NativeRouteDetail | null | undefined) {
    if (!d || typeof d !== "object") return;
    const route = routeFromNative(d);
    if (!route) return;
    const listed = routesFromNative(d.routes);
    const routes = listed.length ? listed : nativeBuiltins(route, this.s.routes);
    const prev = this.s.route;
    if (!this.busy) {
      // remember between calls (headset already connected when the next call starts)
      this.s = { ...this.s, route, routes };
      return;
    }
    const auto = d.user !== true && d.reason !== "override" && (d as { source?: unknown }).source !== "override";
    // a device appeared/disappeared: that is a new situation, so automatic routing takes over again
    if (auto && prev && (isHeadsetKind(route.kind) || isHeadsetKind(prev.kind)) && prev.id !== route.id) this.routeUserPick = false;
    this.set({ route, routes, speaker: route.kind === "speaker", speakerSupported: true, routeSwitchable: true });
    if (auto && prev && this.s.ui === "active") this.announceRoute(routeAnnouncement(prev, route));
    if (auto) this.reassertVideoSpeaker(route, d);
  }

  /** Video call on the app landed on the earpiece without a user pick (Oct 31, call 0d363cbd): put it back on the
   *  speaker once. A headset/Bluetooth route is never overridden (it is not "earpiece"). */
  private reassertVideoSpeaker(route: AudioRoute, d: NativeRouteDetail) {
    if (this.routeUserPick || this.routeReasserted || route.kind !== "earpiece" || !(this.s.camOn || this.s.call?.video)) return;
    this.routeReasserted = true;
    this.diag("route reassert", { from: route.kind, to: "speaker", reason: String(d.reason ?? "") });
    postNative({ type: "call:audioRoute", speaker: true, route: "speaker", auto: true });
  }

  /** Web: enumerate audio outputs → routes; the current one is the picked sinkId, else the system default. */
  private async refreshWebRoutes(announce: boolean) {
    const canSwitch = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
    let outs: { deviceId: string; label: string }[] = [];
    try {
      outs = ((await navigator.mediaDevices?.enumerateDevices?.()) ?? []).filter((d) => d.kind === "audiooutput").map((d) => ({ deviceId: d.deviceId, label: d.label }));
    } catch {
      /* no device list */
    }
    const { routes, current } = routesFromWebOutputs(outs);
    let route = current;
    if (this.webSinkId) {
      const picked = routes.find((r) => r.id === this.webSinkId);
      if (picked) route = picked;
      else {
        // the picked device went away (AirPods out of range / unplugged): back to the system default, and say so
        this.webSinkId = "";
        void this.rtc?.setOutput(null);
      }
    }
    const prev = this.s.route;
    // Safari/Firefox/most phones: no output list or no setSinkId — say what plays and where to change it
    route ??= { id: "default", kind: "system", name: "" };
    const switchable = canSwitch && routes.length > 1;
    this.set({ route, routes: switchable ? routes : [], routeSwitchable: switchable, speakerSupported: true, speaker: route.kind === "speaker" });
    if (announce && prev && this.s.ui === "active") this.announceRoute(routeAnnouncement(prev, route));
  }

  private watchWebRoutes() {
    this.stopWebRouteWatch?.();
    const md = navigator.mediaDevices;
    if (!md?.addEventListener) return;
    const callId = this.s.call?.id;
    let t: ReturnType<typeof setTimeout> | null = null;
    const on = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        if (this.s.call?.id === callId && this.busy) void this.refreshWebRoutes(true);
      }, 400);
    };
    md.addEventListener("devicechange", on);
    this.stopWebRouteWatch = () => {
      if (t) clearTimeout(t);
      md.removeEventListener("devicechange", on);
      this.stopWebRouteWatch = null;
    };
  }

  private teardownMedia() {
    stopTones();
    this.dropMedia();
    this.stopWebRouteWatch?.();
    this.webSinkId = "";
    this.routeUserPick = false;
    this.routeInit = false;
    if (this.routeNoticeTimer) clearTimeout(this.routeNoticeTimer);
    this.routeNoticeTimer = null;
    this.camTrack?.stop();
    this.camTrack = null;
    this.remoteVideo = null;
    if (typeof document !== "undefined") document.querySelectorAll("[data-ol-call-audio]").forEach((el) => el.remove());
    this.media = null;
    this.acceptedHere = false;
    this.acceptT0 = 0;
    this.metricSent = false;
    if (this.weakTimer) clearTimeout(this.weakTimer);
    if (this.nativeAudio()) this.set({ nativeAudio: false, nativeVideo: false });
  }
  private nativeAudio() {
    return !!(this.s.nativeAudio || this.s.nativeVideo);
  }

  // ---------- controls ----------
  async toggleMute() {
    const muted = !this.s.muted;
    this.set({ muted });
    buzz("light");
    this.rtc?.setMuted(muted);
    if (this.native) await this.native.setMuted(muted);
    postNative({ type: "call:muted", muted });
  }

  async toggleCam() {
    const on = !this.s.camOn;
    buzz("light");
    const call = this.s.call;
    if (this.native || useNativeMedia()) {
      try {
        await this.native?.camera(on, this.s.facing);
        this.set({ camOn: on, videoInvite: false });
      } catch {
        this.set({ camOn: false, error: "Camera unavailable. Continuing with audio." });
        return;
      }
    } else if (on) {
      const cam = await this.ensureCamPreview();
      if (!cam) return;
      this.set({ camOn: true, videoInvite: false });
      await this.rtc?.setVideoTrack(cam).catch(() => {});
    } else {
      this.set({ camOn: false });
      await this.rtc?.setVideoTrack(null).catch(() => {});
      this.camTrack?.stop();
      this.camTrack = null;
      this.attachRawVideo(this.videoEls.local, null);
    }
    if (call?.id) void this.req("call:video", { callId: call.id, on }).catch(() => {});
  }

  async flip() {
    if (this.flippingCamera) return;
    const facing = this.s.facing === "user" ? "environment" : "user";
    buzz("light");
    this.flippingCamera = true;
    try {
      if (this.native) await this.native.camera(true, facing);
      else if (this.camTrack) {
        // acquire the other lens first, then swap on the same sender (no renegotiation; preview stays live on failure)
        const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } });
        const next = st.getVideoTracks()[0];
        if (next) {
          await this.rtc?.setVideoTrack(next);
          this.camTrack.stop();
          this.camTrack = next;
          this.logCameraTrack(next, "flip");
          this.attachRawVideo(this.videoEls.local, next);
        }
      }
      this.set({ facing });
    } catch {
      this.set({ error: "Couldn't switch camera" });
    } finally {
      this.flippingCamera = false;
    }
  }

  /** Speaker ⇄ Phone (two built-in routes only). With a headset/Bluetooth device present the UI opens the picker. */
  async toggleSpeaker() {
    const to = this.s.route?.kind === "speaker" ? this.s.routes.find((r) => r.kind === "earpiece") ?? this.s.routes.find((r) => r.kind !== "speaker") : this.s.routes.find((r) => r.kind === "speaker");
    if (to) return this.selectRoute(to.id);
    const speaker = !this.s.speaker;
    this.set({ speaker, route: speaker ? { id: "speaker", kind: "speaker", name: "" } : { id: "earpiece", kind: "earpiece", name: "" } });
    buzz("light");
    postNative({ type: "call:audioRoute", speaker, route: speaker ? "speaker" : "earpiece", user: true });
  }

  /** User picked an output in the route sheet (Speaker / Phone / Headphones / AirPods …). */
  async selectRoute(id: string) {
    const r = this.s.routes.find((x) => x.id === id);
    if (!r) return;
    this.diag("route user", { to: r.kind });
    buzz("light");
    this.routeUserPick = true;
    this.announceRoute(null);
    this.set({ route: r, speaker: r.kind === "speaker", routeNotice: null });
    if (this.inApp()) {
      postNative({ type: "call:audioRoute", speaker: r.kind === "speaker", route: r.kind, deviceId: r.id, user: true });
      return;
    }
    this.webSinkId = r.id === "default" ? "" : r.id;
    void this.rtc?.setOutput(this.webSinkId || null);
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
    this.set({ needsGesture: false });
  }

  /** Video elements from the UI (one per surface; the last-frame hold canvas lives in the component). */
  attachVideo(which: "local" | "remote", elements: HTMLVideoElement | readonly HTMLVideoElement[] | null) {
    const prev = this.videoEls[which];
    const next = (Array.isArray(elements) ? elements : elements ? [elements] : []).filter((el, index, all) => all.indexOf(el) === index);
    this.videoEls[which] = next;
    this.attachRawVideo(next, which === "local" ? this.camTrack : this.remoteVideo);
    for (const el of prev) if (!next.includes(el)) el.srcObject = null;
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

/** wrapper app version + build from the UA (`OpenLounge/<ios|android>/<v>(<b>)`), "" on the plain web */
function appVersionFromUa(): string {
  try {
    const m = /\bOpenLounge\/(ios|android)\/([^\s(]+)\((\d+)\)/i.exec(typeof navigator === "undefined" ? "" : navigator.userAgent);
    return m ? `${m[1]} ${m[2]} (${m[3]})` : "";
  } catch {
    return "";
  }
}
