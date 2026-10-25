// iOS app native call media (openlounge-ios src/nativeMedia.ts): the app owns the microphone, the mediasoup
// transports and the CallKit audio session. This page is UI + signaling only: it relays the app's ms:* requests
// over its authenticated realtime socket and forwards ms:consumer:available. No getUserMedia, no WebView media.
// Audio calls stay native as before; iPhone video is native only when its individual server media grant says so.
// Safari and Android WebView paths never take the iPhone video branch.
import type { CallMedia } from "@/lib/types";
import { voiceLadderBps } from "./audioPolicy";
import type { RealtimeClient } from "@/lib/realtime";
import type { MediasoupRemoteTrack } from "./mediasoupSession";

type NativeMediaBridge = {
  capabilities?: readonly string[];
  platform?: string;
  nativeMedia?(cmd: Record<string, unknown>): Promise<unknown>;
  msReply?(id: string, ok: boolean, result: unknown, error?: string): void;
};

function bridge(): NativeMediaBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { OpenLoungeNative?: NativeMediaBridge; OpenLoungeNativeMedia?: NativeMediaBridge };
  // Android 0.3.16+: a Java JavascriptInterface can't return promises/arrays or take objects, so the app injects a
  // document-start shim with the same contract as the iOS object (nativeMedia/msReply/capabilities).
  return w.OpenLoungeNativeMedia ?? w.OpenLoungeNative ?? null;
}

/** iOS / Android app build with native call media (capability flag injected before any page script). */
export function nativeMediaAvailable(): boolean {
  const b = bridge();
  return !!b && typeof b.nativeMedia === "function" && typeof b.msReply === "function" && !!b.capabilities?.includes("nativeMedia");
}
/** Present only in the paired-media iOS wrapper release; older audio-only native binaries stay on WebView video. */
export function nativeVideoAvailable(): boolean {
  const b = bridge();
  return nativeMediaAvailable() && !!b?.capabilities?.includes("nativeVideo");
}

/** Android builds with the native-media fix (0.3.18 / build 34: software video codec factories for Device.load). */
export const ANDROID_NATIVE_MIN_BUILD = 34;
let androidNativeOff: string | null = null;

/** Android wrapper build number from the WebView UA (`OpenLounge/android/<version>(<build>)`), or null. */
export function androidAppBuild(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): number | null {
  const m = /\bOpenLounge\/android\/[^\s(]+\((\d+)\)/i.exec(ua);
  return m ? Number(m[1]) : null;
}

/**
 * Android baseline moat (Donny, Oct 18). The WebView media path that was live before 1:37 PM MST Oct 17 (a8a754e) is the
 * DEFAULT for the Android app. Native (app-owned) media is opt-in only, and needs all of:
 *   1. server opt-in: the last mediasoup grant carried androidNative:true (CALL_ANDROID_NATIVE=on), remembered on device
 *      so the next call can pre-warm while it rings;
 *   2. app build >= 34;
 *   3. device health guard: no native failure on this device in the last ANDROID_NATIVE_COOLDOWN_MS;
 *   4. no native failure in this page session.
 * Any native failure drops the SAME call to the baseline path and trips the device guard.
 */
const OPT_IN_KEY = "ol.calls.androidNative.optIn";
const FAIL_KEY = "ol.calls.androidNative.failedAt";
export const ANDROID_NATIVE_COOLDOWN_MS = 7 * 24 * 3600_000;
function store(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}
let androidOptIn: boolean | null = null;
/** record the server's opt-in from a media grant (false clears it: server kill switch wins on the next grant) */
export function noteAndroidNativeOptIn(on: boolean) {
  androidOptIn = on;
  try {
    if (on) store()?.setItem(OPT_IN_KEY, "1");
    else store()?.removeItem(OPT_IN_KEY);
  } catch {
    /* storage unavailable: memory only */
  }
}
export function androidNativeOptedIn(): boolean {
  if (androidOptIn !== null) return androidOptIn;
  try {
    return store()?.getItem(OPT_IN_KEY) === "1";
  } catch {
    return false;
  }
}
/** device health guard: a recent native failure on this device keeps it on the baseline path */
let failedAtMem = 0;
export function androidNativeHealthy(now = Date.now()): boolean {
  try {
    const at = Math.max(failedAtMem, Number(store()?.getItem(FAIL_KEY) ?? 0));
    return !at || now - at > ANDROID_NATIVE_COOLDOWN_MS;
  } catch {
    return true;
  }
}

/** A native failure on Android turns native media off for this page session AND trips the device health guard. */
export function disableAndroidNativeMedia(reason: string) {
  androidNativeOff = reason || "failed";
  failedAtMem = Date.now();
  try {
    store()?.setItem(FAIL_KEY, String(Date.now()));
  } catch {
    /* memory-only guard */
  }
}
/** test hook: simulate a fresh page load (session flag cleared, device guard kept) */
export function newAndroidPageSession() {
  androidNativeOff = null;
}
export function androidNativeDisabledReason(): string | null {
  return androidNativeOff;
}
/** test hook */
export function resetAndroidNativeMedia() {
  androidNativeOff = null;
  androidOptIn = null;
  failedAtMem = 0;
  try {
    store()?.removeItem(OPT_IN_KEY);
    store()?.removeItem(FAIL_KEY);
  } catch {
    /* ignore */
  }
}

/** iPhone video is app-owned only for an explicit current-call grant; this is the default-off production gate. */
export function iosNativeVideoGranted(media: CallMedia | null | undefined): boolean {
  return !!media?.iosNativeVideo && !nativeMediaIsAndroid() && nativeVideoAvailable();
}
/** Audio-only calls in the native-media iOS app use app-owned media; iPhone video is allowed only by its grant.
 * Android stays behind its independent opt-in and never inherits the iPhone path. */
export function useNativeMedia(video: boolean, media?: CallMedia | null): boolean {
  if (!nativeMediaAvailable()) return false;
  if (video) return iosNativeVideoGranted(media);
  if (!nativeMediaIsAndroid()) return true;
  return androidNativeOff === null && androidNativeOptedIn() && androidNativeHealthy() && (androidAppBuild() ?? 0) >= ANDROID_NATIVE_MIN_BUILD;
}

/** Android app (0.3.16+ shim sets platform:'android'); the iOS bridge carries no platform */
export function nativeMediaIsAndroid(): boolean {
  return bridge()?.platform === "android";
}

export function nativeMediaCmd(cmd: Record<string, unknown>): Promise<unknown> {
  const b = bridge();
  if (!b?.nativeMedia) return Promise.reject(new Error("native media unavailable"));
  return b.nativeMedia(cmd);
}

/** Ring-time native preparation: install an authenticated relay only while the app loads SFU/LiveKit state.
 * It deliberately never asks the WebView for media and is replaced by the real session relay at answer. */
export async function prepareNativeMedia(socket: RealtimeClient, media: CallMedia, opts: { callId: string; streamId?: string }) {
  const b = bridge();
  if (!b?.nativeMedia || !b.msReply) return;
  const callId = opts.callId;
  const relay = (id: string, event: string, data: Record<string, unknown>) => {
    if (!MS_EVENT.test(event) || data?.callId !== callId) return b.msReply?.(id, false, null, "relay refused");
    socket.request(event, data, 8_000).then((r) => b.msReply?.(id, true, r ?? null), (e: unknown) => b.msReply?.(id, false, null, String((e as Error)?.message ?? e)));
  };
  const w = window as unknown as { __olNativeMsReq?: typeof relay };
  w.__olNativeMsReq = relay;
  try {
    await b.nativeMedia({ op: "prepare", callId, iceServers: media.iceServers ?? [], video: true, nativeVideo: true, ...(opts.streamId ? { streamId: opts.streamId } : {}) });
  } finally {
    if (w.__olNativeMsReq === relay) delete w.__olNativeMsReq;
  }
}

const MS_EVENT = /^ms:[a-z:]+$/i;

/** FX-064: app diag events forwarded to the server log (b67 nativeMedia.ts). */
export const NATIVE_DIAG_EVENTS = new Set(["consume-result", "first-remote-video-frame", "no-remote-video-frame", "ice-recovered", "consumer-resumed", "resume-failed", "remote-video-replaced"]);

export class NativeMediaSession {
  private closed = false;
  private connected = false;

  constructor(
    private socket: RealtimeClient,
    private media: CallMedia,
    private opts: {
      onRemoteTrack(track: MediasoupRemoteTrack): void;
      onState(state: "connected" | "disconnected" | "failed"): void;
      /** App-owned remote camera availability only. The native MediaStream never crosses this bridge. */
      onRemoteVideo?(on: boolean): void;
      onLocalVideo(track: MediaStreamTrack | null): void;
      onCameraUnavailable?(): void;
      tcpOnly?: boolean;
      /** second native rebuild rung: TURN-TLS relay only, never a page fallback */
      relayOnly?: boolean;
      /** server-granted call latch carried across media-provider remints */
      nativeVideo?: boolean;
      /** force fresh native transports (outage recovery) instead of re-attaching to the live session */
      rebuild?: boolean;
      /** LiveKit credentials carry no callId */
      callId?: string;
      /** Explicit msid shared by this caller's audio and camera producers. */
      streamId?: string;
      /** Android 0.3.17+: the app's mediasoup failed in a way a retry can't fix → hand over to LiveKit now */
      onWantsLiveKit?(reason: string): void;
      /** timing of each native step (relayed ms:* request, connect) for diagnostics */
      onStep?(step: { event: string; ms: number; ok: boolean; error?: string }): void;
      /** FX-064: b67+ app media diagnostics (consume results, first remote video frame, ICE recovery) → Railway logs. */
      onNativeDiag?(ev: string, data: Record<string, string | number>): void;
    },
  ) {
  }

  private readonly onAvailable = () => void nativeMediaCmd({ op: "consumerAvailable" }).catch(() => {});
  private readonly onNativeEvent = (e: Event) => {
    if (this.closed) return;
    const d = (e as CustomEvent<{ state?: string; callId?: string; on?: boolean; fallback?: string; reason?: string }>).detail;
    const s = d?.state;
    if (s === "failed" && d?.fallback === "livekit" && this.opts.onWantsLiveKit) {
      this.opts.onWantsLiveKit(String(d.reason ?? "native-ms-failed"));
      return;
    }
    if (s === "media-diag") {
      this.forwardNativeDiag(d as Record<string, unknown>);
      return;
    }
    if (s === "camera-unavailable") this.opts.onCameraUnavailable?.();
    else if (s === "remote-video") {
      const callId = (this.media as { callId?: string }).callId ?? this.opts.callId;
      // App-owned media is retained across a WebView reload. Never apply a late renderer event from a prior call.
      if (typeof d?.callId === "string" && d.callId === callId) this.opts.onRemoteVideo?.(d.on === true);
    }
    else if (s === "connected") {
      if (this.connected) this.opts.onState("connected");
    } else if (s === "disconnected" || s === "failed") this.opts.onState(s);
  };

  /** app → page: one ms:* request relayed over the page socket; the answer goes back via msReply */
  private readonly relay = (id: string, event: string, data: Record<string, unknown>) => {
    const b = bridge();
    if (!b?.msReply) return;
    const callId = (this.media as { callId?: string }).callId ?? this.opts.callId;
    if (this.closed || !MS_EVENT.test(event) || !data || data.callId !== callId) {
      b.msReply(id, false, null, "relay refused");
      return;
    }
    const t0 = Date.now();
    const method = typeof data.method === "string" ? `${event}:${data.method}` : event;
    this.socket.request(event, data, 8_000).then(
      (r) => {
        this.step(method, t0, true);
        b.msReply?.(id, true, r ?? null);
      },
      (err: unknown) => {
        const msg = String((err as Error)?.message ?? err);
        this.step(method, t0, false, msg);
        b.msReply?.(id, false, null, msg);
      },
    );
  };

  /** FX-064: forward only known app diag events for this call, with short scalar fields (log-only, never affects media). */
  private forwardNativeDiag(d: Record<string, unknown>) {
    try {
      const callId = (this.media as { callId?: string }).callId ?? this.opts.callId;
      const ev = typeof d.ev === "string" ? d.ev : "";
      if (!NATIVE_DIAG_EVENTS.has(ev) || d.callId !== callId) return;
      const data: Record<string, string | number> = {};
      for (const k of ["n", "kinds", "ms", "consumers"]) {
        const v = d[k];
        if (typeof v === "number" && Number.isFinite(v)) data[k] = v;
        else if (typeof v === "string") data[k] = v.slice(0, 40);
      }
      this.opts.onNativeDiag?.(ev, data);
    } catch {
      /* diagnostics only */
    }
  }

  private step(event: string, t0: number, ok: boolean, error?: string) {
    try {
      this.opts.onStep?.({ event, ms: Date.now() - t0, ok, ...(error ? { error: error.slice(0, 120) } : {}) });
    } catch {
      /* diagnostics only */
    }
  }

  async connect(withVideo: boolean) {
    const t0 = Date.now();
    try {
      await this.connectInner(withVideo);
      this.step("connect", t0, true);
    } catch (e) {
      this.step("connect", t0, false, String((e as Error)?.message ?? e));
      throw e;
    }
  }

  private async connectInner(withVideo: boolean) {
    const w = window as unknown as { __olNativeMsReq?: NativeMediaSession["relay"] };
    w.__olNativeMsReq = this.relay;
    window.addEventListener("openlounge:native-media", this.onNativeEvent);
    this.socket.on("ms:consumer:available", this.onAvailable);
    const m = this.media as CallMedia & { callId?: string; iceServers?: unknown[]; url?: string; token?: string };
    const callId = m.callId ?? this.opts.callId;
    const nativeVideo = withVideo && (iosNativeVideoGranted(m) || this.opts.nativeVideo === true);
    // Resolves once the app's media is connected (rejects on failure/timeout → engine falls back). Same call + same
    // path after a page reload = the app re-attaches its live media; nothing is rebuilt.
    // LiveKit is removed from calling (Donny, Oct 24 2026): the native lane only joins mediasoup (UDP first, then our
    // TURN relay UDP -> TCP -> TLS 443). A LiveKit grant never reaches the app; rejecting lets the engine keep its
    // non-native path. LiveKit drop-in rooms are a separate code path and are untouched.
    if (m.provider === "livekit") throw new Error("native media: livekit calling removed");
    await nativeMediaCmd({ op: "connect", callId, iceServers: m.iceServers ?? [], ...(nativeVideo ? { video: true, nativeVideo: true, ...(this.opts.streamId ? { streamId: this.opts.streamId } : {}) } : {}), tcpOnly: this.opts.tcpOnly === true, ...(this.opts.relayOnly ? { relayOnly: true } : {}), ...(this.opts.rebuild ? { rebuild: true } : {}) });
    if (this.closed) throw new Error("native media cancelled");
    this.connected = true;
  }

  rebindMic() {
    /* CallKit drives the app's audio unit (isAudioEnabled on didActivate): nothing to re-bind in the page */
  }
  checkMicAlive() {}
  async setMuted(muted: boolean) {
    await nativeMediaCmd({ op: "mute", muted }).catch(() => {});
  }
  async startAudio() {
    return true; // remote audio plays natively, never through a WebView <audio>
  }
  async restartIceAll() {
    // the app also restarts ICE itself (network change / transport disconnected) — this is the page's nudge
    await nativeMediaCmd({ op: "restartIce" }).catch(() => {});
  }
  async applyLadderStep(step: { audioBps: number }): Promise<boolean> {
    // audioBps stays the raw rung: shipped app builds key their camera tier off it (iOS 48k/32k/24k/16k → 850/400/150/60
    // kbps). voiceBps is the Opus cap new builds apply (floor 32k, top 64k); older builds ignore it and keep their own floor.
    return (await nativeMediaCmd({ op: "ladder", audioBps: step.audioBps, voiceBps: voiceLadderBps(step.audioBps) }).catch(() => false)) === true;
  }
  async getTransportStats(): Promise<RTCStatsReport[]> {
    const raw = (await nativeMediaCmd({ op: "stats" }).catch(() => [])) as Array<Array<Record<string, unknown> & { id?: string }>>;
    return (Array.isArray(raw) ? raw : []).map((list) => new Map((list ?? []).map((s, i) => [String(s.id ?? i), s])) as unknown as RTCStatsReport);
  }
  async enableCamera(facing?: string) { await nativeMediaCmd({ op: "camera", on: true, facing: facing === "environment" ? "environment" : "user" }); }
  async disableCamera() { await nativeMediaCmd({ op: "camera", on: false }); }
  /** Native keeps its sensor-oriented capture; adaptive constraints must not restart a live camera. */
  async refreshCameraQuality() { return false; }
  async flipCamera(facing?: string) { await nativeMediaCmd({ op: "camera", on: true, facing: facing === "environment" ? "environment" : "user" }); }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.off("ms:consumer:available", this.onAvailable);
    window.removeEventListener("openlounge:native-media", this.onNativeEvent);
    const w = window as unknown as { __olNativeMsReq?: unknown };
    if (w.__olNativeMsReq === this.relay) delete w.__olNativeMsReq;
    void nativeMediaCmd({ op: "close" }).catch(() => {});
  }
}
