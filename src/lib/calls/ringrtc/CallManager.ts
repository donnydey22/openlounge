// RingRTC CallManager session model, browser port. States/events/hangup reasons mirror RingRTC 2.74.0
// (CallState, CallEvent, HangupType) so web/iOS/Android share one call contract. Media = rtc/CallSession (browser
// WebRTC); signaling = SealedSignaling (OLX3DH-v1 E2E). Not the Signal Desktop Node binding.
import { CallSession, type CallSessionOpts, type RtcSocket } from "../rtc/CallSession";
import type { CallFailure } from "../rtc/CallFailures";
import { SealedSignaling } from "./SealedSignaling";
import type { OlKeyStore } from "./keyStore";

export type RcCallState = "idle" | "starting" | "ringing" | "connecting" | "connected" | "reconnecting" | "ended";
export type RcHangupType = "normal" | "accepted" | "declined" | "busy" | "needPermission" | "timeout" | "failed";
export type RcCallEvent =
  | "localRinging" | "remoteRinging" | "remoteConnected" | "localConnected" | "reconnecting" | "reconnected"
  | "localHangup" | "remoteHangup" | "remoteBusy" | "endedTimeout" | "endedConnectionFailure" | "endedDeviceFailure" | "endedSignalingFailure";

export interface RcCallOpts extends Omit<CallSessionOpts, "onPhase" | "onFailure" | "role"> {
  peerUserId: string;
  direction: "outgoing" | "incoming";
  onState?(s: RcCallState, ev?: RcCallEvent): void;
  onEnded?(h: RcHangupType, f?: CallFailure): void;
}

const RING_TIMEOUT_MS = 60_000; // RingRTC default ring/connect timeout window

export class RcCall {
  state: RcCallState = "idle";
  private sealed: SealedSignaling;
  private session: CallSession | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private sock: RtcSocket, keys: OlKeyStore, private o: RcCallOpts) {
    this.sealed = new SealedSignaling(sock, keys, { callId: o.callId, role: o.direction === "outgoing" ? "caller" : "callee", peerUserId: o.peerUserId, log: o.log });
  }

  private set(s: RcCallState, ev?: RcCallEvent) { if (this.state === "ended") return; this.state = s; this.o.onState?.(s, ev); }

  /** outgoing: RingRTC call() → proceed(); incoming: called when the user accepts (RingRTC accept()). */
  async proceed(): Promise<void> {
    this.set(this.o.direction === "outgoing" ? "starting" : "connecting", this.o.direction === "outgoing" ? "remoteRinging" : undefined);
    this.timer = setTimeout(() => this.end("timeout", undefined, "endedTimeout"), RING_TIMEOUT_MS);
    const s = new CallSession(this.sealed, {
      ...this.o,
      role: this.o.direction === "outgoing" ? "caller" : "callee",
      onPhase: (p) => {
        if (p === "transport") this.set("connecting");
        else if (p === "media-running") { this.clear(); this.set("connected", this.state === "reconnecting" ? "reconnected" : "localConnected"); }
        else if (p === "recovering") this.set("reconnecting", "reconnecting");
      },
      onFailure: (f) => this.end(f.kind === "permission" ? "needPermission" : "failed", f, f.kind === "network" ? "endedConnectionFailure" : f.kind === "signaling" ? "endedSignalingFailure" : "endedDeviceFailure"),
    });
    this.session = s;
    try { await s.start(); } catch (e) { this.end("failed", e as CallFailure, "endedDeviceFailure"); throw e; }
  }

  /** incoming before accept: RingRTC localRinging */
  ring() { this.set("ringing", "localRinging"); }
  setMuted(m: boolean) { this.session?.setMuted(m); }
  get media() { return this.session; }

  remoteHangup(h: RcHangupType) { this.end(h, undefined, h === "busy" ? "remoteBusy" : "remoteHangup"); }
  hangup() { this.end("normal", undefined, "localHangup"); }

  private clear() { if (this.timer) clearTimeout(this.timer); this.timer = null; }
  private end(h: RcHangupType, f: CallFailure | undefined, ev: RcCallEvent) {
    if (this.state === "ended") return;
    this.clear();
    this.set("ended", ev);
    this.state = "ended";
    this.session?.close();
    this.sealed.close();
    this.o.onEnded?.(h, f);
  }
}

/** One active call at a time (RingRTC CallManager); second incoming → busy. */
export class RcCallManager {
  private active: RcCall | null = null;
  constructor(private sock: RtcSocket, private keys: OlKeyStore) {}
  get current() { return this.active; }
  create(o: RcCallOpts): RcCall | "busy" {
    if (this.active && this.active.state !== "ended") return "busy";
    const c = new RcCall(this.sock, this.keys, { ...o, onEnded: (h, f) => { if (this.active === c) this.active = null; o.onEnded?.(h, f); } });
    this.active = c;
    return c;
  }
  /** publish/refresh prekey bundle on login / when server reports low OPK count */
  async publishKeys() { return this.sock.request<{ ok: boolean }>("rc:keys:publish", await this.keys.publishable()); }
}
