// iOS app native call media (openlounge-ios src/nativeMedia.ts): the app owns the microphone, the mediasoup
// transports and the CallKit audio session. This page is UI + signaling only: it relays the app's ms:* requests
// over its authenticated realtime socket and forwards ms:consumer:available. No getUserMedia, no WebView media.
// Audio-only calls only (video calls keep the WebView path). Safari / Android web paths never take this branch.
import type { CallMedia } from "@/lib/types";
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

/** Audio-only calls in the native-media iOS app use app-owned media; Android only when opted in (see above). */
export function useNativeMedia(video: boolean): boolean {
  if (video || !nativeMediaAvailable()) return false;
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

const MS_EVENT = /^ms:[a-z:]+$/i;

export class NativeMediaSession {
  private closed = false;
  private connected = false;

  constructor(
    private socket: RealtimeClient,
    private media: CallMedia,
    private opts: {
      onRemoteTrack(track: MediasoupRemoteTrack): void;
      onState(state: "connected" | "disconnected" | "failed"): void;
      onLocalVideo(track: MediaStreamTrack | null): void;
      tcpOnly?: boolean;
      /** force fresh native transports (outage recovery) instead of re-attaching to the live session */
      rebuild?: boolean;
      /** LiveKit credentials carry no callId */
      callId?: string;
      /** Android 0.3.17+: the app's mediasoup failed in a way a retry can't fix → hand over to LiveKit now */
      onWantsLiveKit?(reason: string): void;
      /** timing of each native step (relayed ms:* request, connect) for diagnostics */
      onStep?(step: { event: string; ms: number; ok: boolean; error?: string }): void;
    },
  ) {
  }

  private readonly onAvailable = () => void nativeMediaCmd({ op: "consumerAvailable" }).catch(() => {});
  private readonly onNativeEvent = (e: Event) => {
    if (this.closed) return;
    const d = (e as CustomEvent<{ state?: string; fallback?: string; reason?: string }>).detail;
    const s = d?.state;
    if (s === "failed" && d?.fallback === "livekit" && this.opts.onWantsLiveKit) {
      this.opts.onWantsLiveKit(String(d.reason ?? "native-ms-failed"));
      return;
    }
    if (s === "connected") {
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

  private step(event: string, t0: number, ok: boolean, error?: string) {
    try {
      this.opts.onStep?.({ event, ms: Date.now() - t0, ok, ...(error ? { error: error.slice(0, 120) } : {}) });
    } catch {
      /* diagnostics only */
    }
  }

  async connect(_withVideo: boolean) {
    const t0 = Date.now();
    try {
      await this.connectInner();
      this.step("connect", t0, true);
    } catch (e) {
      this.step("connect", t0, false, String((e as Error)?.message ?? e));
      throw e;
    }
  }

  private async connectInner() {
    const w = window as unknown as { __olNativeMsReq?: NativeMediaSession["relay"] };
    w.__olNativeMsReq = this.relay;
    window.addEventListener("openlounge:native-media", this.onNativeEvent);
    this.socket.on("ms:consumer:available", this.onAvailable);
    const m = this.media as CallMedia & { callId?: string; iceServers?: unknown[]; url?: string; token?: string };
    const callId = m.callId ?? this.opts.callId;
    // Resolves once the app's media is connected (rejects on failure/timeout → engine falls back). Same call + same
    // path after a page reload = the app re-attaches its live media; nothing is rebuilt.
    if (m.provider === "livekit") await nativeMediaCmd({ op: "connectLiveKit", callId, url: m.url, token: m.token, iceServers: m.iceServers ?? [] });
    else await nativeMediaCmd({ op: "connect", callId, iceServers: m.iceServers ?? [], tcpOnly: this.opts.tcpOnly === true, ...(this.opts.rebuild ? { rebuild: true } : {}) });
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
    return (await nativeMediaCmd({ op: "ladder", audioBps: step.audioBps }).catch(() => false)) === true;
  }
  async getTransportStats(): Promise<RTCStatsReport[]> {
    const raw = (await nativeMediaCmd({ op: "stats" }).catch(() => [])) as Array<Array<Record<string, unknown> & { id?: string }>>;
    return (Array.isArray(raw) ? raw : []).map((list) => new Map((list ?? []).map((s, i) => [String(s.id ?? i), s])) as unknown as RTCStatsReport);
  }
  async enableCamera() {}
  async disableCamera() {}
  async refreshCameraQuality() {}
  async flipCamera() {}

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
