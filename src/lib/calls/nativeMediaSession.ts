// Native app call media (iOS OLRtcCall / Android RtcCallSession): when the app advertises the rtcP2P capability it owns
// the microphone, camera and the one WebRTC PeerConnection (RingRTC session model, OLX3DH-v1 keys held by the app).
// This page is UI + transport only: it relays the app's rc:* / rtc:* requests over its authenticated realtime socket
// and forwards server rc:msg / rtc:signal to the app. No getUserMedia, no WebView media. There is no other native lane.
import type { CallMedia } from "@/lib/types";
import type { RealtimeClient } from "@/lib/realtime";

type NativeMediaBridge = {
  capabilities?: readonly string[];
  platform?: string;
  nativeMedia?(cmd: Record<string, unknown>): Promise<unknown>;
  msReply?(id: string, ok: boolean, result: unknown, error?: string): void;
};

function bridge(): NativeMediaBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { OpenLoungeNative?: NativeMediaBridge; OpenLoungeNativeMedia?: NativeMediaBridge };
  return w.OpenLoungeNativeMedia ?? w.OpenLoungeNative ?? null;
}

/** iOS / Android app build with native call media (capability flag injected before any page script). */
export function nativeMediaAvailable(): boolean {
  const b = bridge();
  return !!b && typeof b.nativeMedia === "function" && typeof b.msReply === "function" && !!b.capabilities?.includes("nativeMedia");
}
/** App build implements the P2P rtc contract (connect media+caller, op rtcSignal/rcMsg, rc:* + rtc:* relay). */
export const RTC_P2P_CAPABILITY = "rtcP2P";
export function nativeRtcP2PAvailable(): boolean {
  return nativeMediaAvailable() && !!bridge()?.capabilities?.includes(RTC_P2P_CAPABILITY);
}
export function nativeCallingProtocolAvailable():boolean {return nativeRtcP2PAvailable() && !!bridge()?.capabilities?.includes("ol-rc-v1")}
/** The app owns call media (audio and video) whenever it implements the P2P contract. Older builds: browser CallSession. */
export function useNativeMedia(): boolean {
  return nativeRtcP2PAvailable();
}
/** Android app (shim sets platform:'android'); the iOS bridge carries no platform */
export function nativeMediaIsAndroid(): boolean {
  return bridge()?.platform === "android";
}

export function nativeMediaCmd(cmd: Record<string, unknown>): Promise<unknown> {
  const b = bridge();
  if (!b?.nativeMedia) return Promise.reject(new Error("native media unavailable"));
  return b.nativeMedia(cmd);
}

/** app→page requests the page may relay: the RingRTC session model (sealed rc:*) and OL ICE config. */
const RELAY_EVENT = /^(rtc:signal|rtc:iceConfig|rc:msg|rc:keys:publish|rc:keys:fetch)$/i;

/**
 * Page realtime socket (re)connected: give the app a standing relay for rc:keys:publish ONLY (no call needed) and
 * tell it to publish its OLX3DH-v1 bundle now. Fixes the Android race where keys were first published lazily on the
 * first call op, so a caller could rc:keys:fetch before the callee's bundle existed. A live call session's relay
 * (NativeMediaSession.connect) takes precedence; this one never relays call traffic.
 */
export function nativeSignalConnected(socket: RealtimeClient) {
  if (!nativeRtcP2PAvailable()) return;
  const w = window as unknown as { __olNativeMsReq?: (id: string, event: string, data: Record<string, unknown>) => void; __olNativeKeysRelay?: boolean };
  if (!w.__olNativeMsReq || w.__olNativeKeysRelay) {
    w.__olNativeKeysRelay = true;
    w.__olNativeMsReq = (id, event, data) => {
      const b = bridge();
      if (event !== "rc:keys:publish") return b?.msReply?.(id, false, null, "relay refused");
      socket.request(event, data, 8_000).then((r) => b?.msReply?.(id, true, r ?? null), (e: unknown) => b?.msReply?.(id, false, null, String((e as Error)?.message ?? e)));
    };
  }
  void nativeMediaCmd({ op: "signalConnected" }).catch(() => {});
}

export class NativeMediaSession {
  private closed = false;

  constructor(
    private socket: RealtimeClient,
    private media: CallMedia,
    private opts: {
      callId: string;
      /** this device placed the call (offerer per rtc contract) */
      caller: boolean;
      onState(state: "connected" | "disconnected" | "failed"): void;
      /** app-owned remote camera availability only; the native MediaStream never crosses this bridge */
      onRemoteVideo?(on: boolean): void;
      onCameraUnavailable?(): void;
      log?(ev: string, d?: Record<string, unknown>): void;
    },
  ) {}

  private forward(op: string) {
    return (d: unknown) => {
      if (this.closed || !d || (d as { callId?: unknown }).callId !== this.opts.callId) return;
      void nativeMediaCmd({ op, data: d }).catch(() => {});
    };
  }
  private readonly onRtcSignal = this.forward("rtcSignal");
  private readonly onRcMsg = this.forward("rcMsg");

  private readonly onNativeEvent = (e: Event) => {
    if (this.closed) return;
    const d = (e as CustomEvent<{ state?: string; callId?: string; on?: boolean }>).detail;
    const s = d?.state;
    if (s === "camera-unavailable") this.opts.onCameraUnavailable?.();
    else if (s === "remote-video") {
      if (typeof d?.callId === "string" && d.callId === this.opts.callId) this.opts.onRemoteVideo?.(d.on === true);
    } else if (s === "connected" || s === "disconnected" || s === "failed") this.opts.onState(s);
  };

  /** app → page: one rc:* / rtc:* request relayed over the page socket; the answer goes back via msReply */
  private readonly relay = (id: string, event: string, data: Record<string, unknown>) => {
    const b = bridge();
    if (!b?.msReply) return;
    if (this.closed || !RELAY_EVENT.test(event) || !data || (event !== "rc:keys:publish" && data.callId !== this.opts.callId)) {
      b.msReply(id, false, null, "relay refused");
      return;
    }
    this.socket.request(event, data, 8_000).then(
      (r) => b.msReply?.(id, true, r ?? null),
      (err: unknown) => b.msReply?.(id, false, null, String((err as Error)?.message ?? err)),
    );
  };

  async connect(withVideo: boolean) {
    const w = window as unknown as { __olNativeMsReq?: NativeMediaSession["relay"]; __olNativeKeysRelay?: boolean };
    w.__olNativeMsReq = this.relay;
    w.__olNativeKeysRelay = false;
    window.addEventListener("openlounge:native-media", this.onNativeEvent);
    this.socket.on("rtc:signal", this.onRtcSignal);
    this.socket.on("rc:msg", this.onRcMsg);
    await nativeMediaCmd({ op: "connect", callId: this.opts.callId, iceServers: this.media.iceServers ?? [], media: this.media, caller: this.opts.caller, ...(withVideo ? { video: true } : {}) });
    if (this.closed) throw new Error("native media cancelled");
  }

  async setMuted(muted: boolean) { await nativeMediaCmd({ op: "mute", muted }).catch(() => {}); }
  async restartIce() { await nativeMediaCmd({ op: "restartIce" }).catch(() => {}); }
  async stats(): Promise<RTCStatsReport[]> {
    const raw = (await nativeMediaCmd({ op: "stats" }).catch(() => [])) as Array<Array<Record<string, unknown> & { id?: string }>>;
    return (Array.isArray(raw) ? raw : []).map((list) => new Map((list ?? []).map((s, i) => [String(s.id ?? i), s])) as unknown as RTCStatsReport);
  }
  async camera(on: boolean, facing?: string) { await nativeMediaCmd({ op: "camera", on, facing: facing === "environment" ? "environment" : "user" }); }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.off("rtc:signal", this.onRtcSignal);
    this.socket.off("rc:msg", this.onRcMsg);
    window.removeEventListener("openlounge:native-media", this.onNativeEvent);
    const w = window as unknown as { __olNativeMsReq?: unknown };
    if (w.__olNativeMsReq === this.relay) delete w.__olNativeMsReq; // next signalConnected re-installs the keys relay
    void nativeMediaCmd({ op: "close" }).catch(() => {});
  }
}
