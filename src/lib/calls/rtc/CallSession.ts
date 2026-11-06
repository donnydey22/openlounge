// The ONE browser calling media path: 1:1 P2P WebRTC over OL signaling (rtc:signal) with OL ICE (rtc:iceConfig).
// Maps Signal Desktop/RingRTC call behavior onto browser WebRTC: caller offers, callee answers, trickle ICE,
// call-scoped generation, ICE restart on network failure only, local failures never touch transport.
// Lifecycle: permission → device-open → transport-ready → media-running.
import type { CallMedia, TurnIceServer } from "../../types";
import { AudioPlayback } from "./AudioPlayback";
import { BrowserAudioOwner } from "./BrowserAudioOwner";
import { CallFailure, fromSignalingError } from "./CallFailures";
import { NetworkRecovery } from "./NetworkRecovery";

export interface RtcSocket {
  on(ev: string, fn: (d: unknown) => void): void;
  off(ev: string, fn: (d: unknown) => void): void;
  request<T = unknown>(ev: string, data?: unknown, timeoutMs?: number): Promise<T>;
}

export type SessionPhase = "idle" | "permission" | "device-open" | "transport" | "media-running" | "recovering" | "closed";

export interface CallSessionOpts {
  callId: string;
  role: "caller" | "callee";
  media: CallMedia;
  video?: boolean;
  onPhase?(p: SessionPhase): void;
  onFailure?(f: CallFailure): void;
  onRemoteTrack?(t: MediaStreamTrack, s: MediaStream): void;
  log?(ev: string, data?: Record<string, unknown>): void;
  /** test seam */
  createPeer?(cfg: RTCConfiguration): RTCPeerConnection;
}

type Incoming = { callId: string; gen: number; kind: string; sdp?: string; candidate?: RTCIceCandidateInit | null };

export class CallSession {
  readonly audio = new BrowserAudioOwner();
  readonly playback = new AudioPlayback();
  private pc: RTCPeerConnection | null = null;
  private gen = 0;
  private seq = 0;
  private signalQueue: Promise<void> = Promise.resolve();
  private offerTask: Promise<void> | null = null;
  private pendingCands: RTCIceCandidateInit[] = [];
  private remoteSet = false;
  private recovery: NetworkRecovery;
  private phase: SessionPhase = "idle";
  private connectedResolve: (() => void) | null = null;
  private connectedReject: ((e: Error) => void) | null = null;
  private onlineH = () => this.recovery.onNetworkChange();
  private videoTx: RTCRtpTransceiver | null = null;
  private localStream: MediaStream | null = null;
  private localVideo: MediaStreamTrack | null = null;

  constructor(private socket: RtcSocket, private o: CallSessionOpts) {
    this.recovery = new NetworkRecovery({
      restart: (n) => this.iceRestart(n),
      giveUp: () => this.fail(new CallFailure("network", "recovery-exhausted")),
      log: o.log,
    });
    this.playback.onFailure = (f) => o.onFailure?.(f); // local: reported, never recovered over network
  }

  get state() { return this.phase; }
  get peer() { return this.pc; }

  private setPhase(p: SessionPhase) {
    if (this.phase === "closed" || this.phase === p) return;
    this.phase = p;
    this.o.onPhase?.(p);
  }

  /** Resolves when ICE first connects. Rejects with CallFailure (local failures reject before any transport work). */
  async start(): Promise<void> {
    this.setPhase("permission");
    this.setPhase("device-open");
    const track = await this.audio.open(); // CallFailure(permission|device) propagates; no TURN, no restart
    if (this.phase === "closed") throw new CallFailure("session", "closed");
    this.setPhase("transport");
    const pc = this.newPeer(this.o.media.iceServers);
    const stream = new MediaStream([track]);
    pc.addTrack(track, stream);
    // One video m-line from the start (caller offers it; callee flips it to sendrecv) so the camera can be turned on
    // or off mid-call with replaceTrack only: no renegotiation, same PC, same ICE (RingRTC: one PC per call).
    if (this.o.role === "caller") this.videoTx = pc.addTransceiver("video", { direction: "sendrecv", streams: [stream] });
    this.localStream = stream;
    this.socket.on("rtc:signal", this.onSignal);
    if (typeof window !== "undefined") window.addEventListener("online", this.onlineH);
    const connected = new Promise<void>((res, rej) => { this.connectedResolve = res; this.connectedReject = rej; });
    if (this.o.role === "caller") await this.sendOffer(false);
    else await this.send("ready", {});
    return connected;
  }

  private newPeer(ice?: TurnIceServer[]): RTCPeerConnection {
    const cfg: RTCConfiguration = { iceServers: ice ?? [], iceTransportPolicy: "all", bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" };
    const pc = this.o.createPeer ? this.o.createPeer(cfg) : new RTCPeerConnection(cfg);
    pc.onicecandidate = (e) => void this.send("candidate", { candidate: e.candidate ? e.candidate.toJSON() : null }).catch(() => {});
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      if (e.track.kind === "audio") this.playback.attach(stream);
      this.o.onRemoteTrack?.(e.track, stream);
    };
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      this.o.log?.("ice-state", { st, gen: this.gen });
      if (st === "connected" || st === "completed") {
        this.setPhase("media-running");
        this.connectedResolve?.();
        this.connectedResolve = null;
        this.connectedReject = null;
      } else if (st === "disconnected" || st === "failed") {
        if (this.connectedResolve && st === "failed") return this.fail(new CallFailure("network", "ice-failed-first-connect"));
        this.setPhase("recovering");
      }
      this.recovery.onTransportState(st);
    };
    this.pc = pc;
    return pc;
  }

  private async send(kind: string, extra: Record<string, unknown>) {
    const r = await this.socket.request<{ ok: boolean; error?: string }>("rtc:signal", { callId: this.o.callId, gen: this.gen, seq: this.seq++, kind, ...extra });
    if (!r?.ok && r?.error && r.error !== "replayed") this.o.onFailure?.(fromSignalingError(r.error));
  }

  private sendOffer(restart: boolean): Promise<void> {
    if (this.offerTask) return this.offerTask;
    this.offerTask = (async () => {
      const pc = this.pc;
      if (!pc || this.phase === "closed") return;
      const offer = await pc.createOffer(restart ? { iceRestart: true } : {});
      if (this.pc !== pc) return;
      await pc.setLocalDescription(offer);
      await this.send("offer", { sdp: pc.localDescription?.sdp ?? offer.sdp });
    })().finally(() => { this.offerTask = null; });
    return this.offerTask;
  }

  private onSignal = (raw: unknown) => {
    const m = raw as Incoming;
    if (!m || m.callId !== this.o.callId || this.phase === "closed") return;
    // SDP apply/create operations must never overlap (ready can arrive during initial createOffer).
    this.signalQueue = this.signalQueue.then(async () => {
      if (this.phase === "closed" || m.gen < this.gen) return;
      if (m.gen > this.gen) this.gen = m.gen;
      await this.handle(m);
    }).catch((e) => this.o.log?.("signal-error", { kind: m.kind, err: String((e as Error)?.message ?? e).slice(0, 120) }));
  };

  private async handle(m: Incoming) {
    const pc = this.pc;
    if (!pc) return;
    switch (m.kind) {
      case "ready":
        // callee attached late: re-send the current offer (caller only, before an answer arrived)
        if (this.o.role === "caller" && pc.signalingState === "have-local-offer") await this.send("offer", { sdp: pc.localDescription?.sdp });
        else if (this.o.role === "caller" && pc.signalingState === "stable" && !this.remoteSet) await this.sendOffer(false);
        return;
      case "offer":
        if (this.o.role !== "callee" || !m.sdp) return;
        if (pc.remoteDescription?.sdp === m.sdp && pc.signalingState === "stable" && pc.localDescription?.type === "answer") {
          await this.send("answer", { sdp: pc.localDescription.sdp }); return;
        }
        await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
        this.remoteSet = true;
        if (!this.videoTx) {
          this.videoTx = pc.getTransceivers().find((t) => t.receiver.track?.kind === "video") ?? null;
          if (this.videoTx) {
            this.videoTx.direction = "sendrecv";
            if (this.localVideo) await this.videoTx.sender.replaceTrack(this.localVideo);
          }
        }
        await this.flushCands();
        await pc.setLocalDescription(await pc.createAnswer());
        await this.send("answer", { sdp: pc.localDescription?.sdp });
        return;
      case "answer":
        if (this.o.role !== "caller" || !m.sdp || pc.signalingState !== "have-local-offer") return;
        await pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
        this.remoteSet = true;
        await this.flushCands();
        return;
      case "candidate":
        if (m.candidate === undefined) return;
        if (!this.remoteSet) { if (m.candidate) this.pendingCands.push(m.candidate); return; }
        await pc.addIceCandidate(m.candidate ?? undefined).catch(() => {});
        return;
      case "restart":
        if (this.o.role === "caller") await this.iceRestart(0);
        return;
      case "bye":
        this.close();
        return;
    }
  }

  private async flushCands() {
    const c = this.pendingCands.splice(0);
    for (const x of c) await this.pc?.addIceCandidate(x).catch(() => {});
  }

  /** Network recovery only: refresh OL ICE creds, bump generation, ICE-restart (caller drives; callee asks). */
  private async iceRestart(_attempt: number) {
    const pc = this.pc;
    if (!pc || this.phase === "closed") return;
    const r = await this.socket.request<{ ok: boolean; config?: { iceServers: RTCIceServer[] } }>("rtc:iceConfig", { callId: this.o.callId }).catch(() => null);
    if (r?.ok && r.config) pc.setConfiguration({ ...pc.getConfiguration(), iceServers: r.config.iceServers });
    this.gen++;
    this.seq = 0;
    this.remoteSet = false;
    if (this.o.role === "caller") await this.sendOffer(true);
    else await this.send("restart", {});
  }

  setMuted(m: boolean) { this.audio.setMuted(m); }

  async setInput(id: string | null) {
    const t = await this.audio.open(id); // local; failure reported, transport untouched
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === "audio");
    await sender?.replaceTrack(t);
  }

  setOutput(id: string | null) { return this.playback.setOutput(id); }

  /** Local camera onto the call's single video sender (null = camera off). Local only: never touches transport. */
  async setVideoTrack(t: MediaStreamTrack | null) {
    this.localVideo = t;
    if (t && this.localStream) { try { this.videoTx?.sender.setStreams?.(this.localStream); } catch { /* older engines */ } }
    await this.videoTx?.sender.replaceTrack(t);
  }

  /** Transport stats for telemetry / level logs (read-only). */
  async stats(): Promise<RTCStatsReport[]> {
    return this.pc ? [await this.pc.getStats()] : [];
  }

  private fail(f: CallFailure) {
    this.o.onFailure?.(f);
    this.connectedReject?.(f);
    this.connectedResolve = null;
    this.connectedReject = null;
  }

  close() {
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.o.onPhase?.("closed");
    this.recovery.stop();
    this.socket.off("rtc:signal", this.onSignal);
    if (typeof window !== "undefined") window.removeEventListener("online", this.onlineH);
    this.pc?.close();
    this.pc = null;
    this.videoTx = null;
    this.localVideo = null;
    this.audio.close();
    this.playback.close();
    this.connectedReject?.(new CallFailure("session", "closed"));
    this.connectedResolve = this.connectedReject = null;
  }
}
