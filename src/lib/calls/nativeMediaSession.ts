// iOS app native call media (openlounge-ios src/nativeMedia.ts): the app owns the microphone, the mediasoup
// transports and the CallKit audio session. This page is UI + signaling only: it relays the app's ms:* requests
// over its authenticated realtime socket and forwards ms:consumer:available. No getUserMedia, no WebView media.
// Audio-only calls only (video calls keep the WebView path). Safari / Android web paths never take this branch.
import type { CallMedia } from "@/lib/types";
import type { RealtimeClient } from "@/lib/realtime";
import type { MediasoupRemoteTrack } from "./mediasoupSession";

type NativeMediaBridge = {
  capabilities?: readonly string[];
  nativeMedia?(cmd: Record<string, unknown>): Promise<unknown>;
  msReply?(id: string, ok: boolean, result: unknown, error?: string): void;
};

function bridge(): NativeMediaBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { OpenLoungeNative?: NativeMediaBridge }).OpenLoungeNative ?? null;
}

/** iOS app build with native call media (capability flag injected before any page script). */
export function nativeMediaAvailable(): boolean {
  const b = bridge();
  return !!b && typeof b.nativeMedia === "function" && typeof b.msReply === "function" && !!b.capabilities?.includes("nativeMedia");
}

/** Audio-only calls in the native-media iOS app use app-owned media. */
export function useNativeMedia(video: boolean): boolean {
  return !video && nativeMediaAvailable();
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
    },
  ) {
    if (media.provider !== "mediasoup") throw new Error("Expected Mediasoup media");
  }

  private readonly onAvailable = () => void nativeMediaCmd({ op: "consumerAvailable" }).catch(() => {});
  private readonly onNativeEvent = (e: Event) => {
    if (this.closed) return;
    const s = (e as CustomEvent<{ state?: string }>).detail?.state;
    if (s === "connected") {
      if (this.connected) this.opts.onState("connected");
    } else if (s === "disconnected" || s === "failed") this.opts.onState(s);
  };

  /** app → page: one ms:* request relayed over the page socket; the answer goes back via msReply */
  private readonly relay = (id: string, event: string, data: Record<string, unknown>) => {
    const b = bridge();
    if (!b?.msReply) return;
    const callId = (this.media as { callId?: string }).callId;
    if (this.closed || !MS_EVENT.test(event) || !data || data.callId !== callId) {
      b.msReply(id, false, null, "relay refused");
      return;
    }
    this.socket.request(event, data, 8_000).then(
      (r) => b.msReply?.(id, true, r ?? null),
      (err: unknown) => b.msReply?.(id, false, null, String((err as Error)?.message ?? err)),
    );
  };

  async connect(_withVideo: boolean) {
    const w = window as unknown as { __olNativeMsReq?: NativeMediaSession["relay"] };
    w.__olNativeMsReq = this.relay;
    window.addEventListener("openlounge:native-media", this.onNativeEvent);
    this.socket.on("ms:consumer:available", this.onAvailable);
    const m = this.media as CallMedia & { callId?: string; iceServers?: unknown[] };
    // resolves once the app's send transport is ICE/DTLS-connected (rejects on failure/timeout → engine falls back)
    await nativeMediaCmd({ op: "connect", callId: m.callId, iceServers: m.iceServers ?? [], tcpOnly: this.opts.tcpOnly === true });
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
