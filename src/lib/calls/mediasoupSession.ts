import type { CallMedia } from "@/lib/types";
import type { RealtimeClient } from "@/lib/realtime";
import { nativePlatform } from "@/lib/native";
import { audioContext } from "@/lib/audioUnlock";
import { CallVoiceProcessor, isAudioContextRunning } from "./voiceProcessing";
import { CALL_AUDIO_CONSTRAINTS, MIC_AUDIO_ENCODING, OPUS_VOICE_CODEC_OPTIONS, micNeedsRecovery, shouldRestartIce, useRawDirectCallMicrophone } from "./audioPolicy";
import { inputKeys, shouldReacquireMic } from "../audioDevices";
import { applyCameraCaptureQuality, applyCameraQualityHint, browserNetworkTier, cameraCaptureConstraints, type NetworkTier } from "./videoPolicy";

export type MediasoupRemoteTrack = { kind: "audio" | "video"; track: MediaStreamTrack; close: () => void; receiver?: RTCRtpReceiver };

type DeviceLike = InstanceType<typeof import("mediasoup-client").Device>;
type TransportLike = ReturnType<DeviceLike["createSendTransport"]>;
type RecvTransportLike = ReturnType<DeviceLike["createRecvTransport"]>;

const CONNECT_TIMEOUT_MS = 8_000;
/** Absolute ceiling for a connect including paused local work (mic permission prompt, chunk load). */
const CONNECT_HARD_CAP_MS = 30_000;
/** Re-check interval while UDP ICE is still progressing past the 8 s budget (no TCP while UDP is mid-handshake). */
const ICE_PROGRESS_GRACE_MS = 2_000;

/** Resolves when a mediasoup-client transport reaches "connected"; rejects on "failed"/"closed". */
export function waitTransportConnected(t: { connectionState?: string; on(ev: "connectionstatechange", fn: (s: string) => void): unknown; off?(ev: "connectionstatechange", fn: (s: string) => void): unknown }) {
  if (t.connectionState === "connected") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const fn = (state: string) => {
      if (state === "connected") {
        t.off?.("connectionstatechange", fn);
        resolve();
      } else if (state === "failed" || state === "closed") {
        t.off?.("connectionstatechange", fn);
        reject(new Error(`UDP transport ${state}`));
      }
    };
    t.on("connectionstatechange", fn);
  });
}

/**
 * Browser half of the brokered Mediasoup protocol. The only network API used here is the app's authenticated
 * RealtimeClient; the SFU control connection and its long-lived secret stay server-side.
 */
export class MediasoupCallSession {
  private device: DeviceLike | null = null;
  private send: TransportLike | null = null;
  private recv: RecvTransportLike | null = null;
  private mic: MediaStreamTrack | null = null;
  /** Keeps the raw capture alive while its bounded Web Audio output is sent; null means the raw mic is sent safely. */
  private micProcessor: CallVoiceProcessor | null = null;
  private micProcessorContext: AudioContext | null = null;
  private micOutbound: MediaStreamTrack | null = null;
  private micProcessorSync: Promise<void> = Promise.resolve();
  private camera: MediaStreamTrack | null = null;
  private consumers = new Map<string, { close(): void; track: MediaStreamTrack }>();
  private producers = new Map<"audio" | "video", {
    close(): void;
    pause(): void | Promise<void>;
    resume(): void | Promise<void>;
    replaceTrack?(input: { track: MediaStreamTrack }): Promise<void>;
    rtpSender?: RTCRtpSender;
  }>();
  private closed = false;
  private syncing = false;
  /** A consumer:available notice arrived while a sync was in flight; run another pass so late producers are never dropped. */
  private syncAgain = false;
  private syncDone: Promise<void> | null = null;
  private connected = false;
  private joined = false;
  private generation = 0;
  private readonly onAvailable = () => void this.syncConsumers().catch(() => {});
  private readonly onMicAudioState = () => void this.queueMicProcessorSync();
  /** Transports whose ICE restart already ran in the current outage; a second failure goes to the TCP fallback. */
  private iceRestarted = new Set<string>();
  private micRecovering: Promise<void> | null = null;
  private readonly onMicEnded = () => void this.recoverMic();
  private inputSnapshot: string[] | null = null;
  private readonly onDeviceChange = () => void this.checkMicDevice();

  constructor(
    private socket: RealtimeClient,
    private media: CallMedia,
    private opts: {
      onRemoteTrack(track: MediasoupRemoteTrack): void;
      onState(state: "connected" | "disconnected" | "failed"): void;
      onLocalVideo(track: MediaStreamTrack | null): void;
    },
  ) {
    if (media.provider !== "mediasoup") throw new Error("Expected Mediasoup media");
  }

  /**
   * The 8 s UDP budget measures the network (signaling + ICE/DTLS) only. Local work that can block on the user or a
   * cold WebView, i.e. the first-run microphone permission prompt after an install and the mediasoup-client chunk
   * load, pauses it. Otherwise a fresh install (Keiko, 2026-10-15 04:30 PT: accept→fallback 8.06 s while the
   * callee's app had cold-started 8 s earlier) is misread as "UDP blocked" and the call drops to LiveKit TCP.
   * A hard cap still bounds the whole connect.
   */
  private budget: { pause(): void; resume(): void } | null = null;

  async connect(withVideo: boolean) {
    const generation = ++this.generation;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cap: ReturnType<typeof setTimeout> | null = null;
    let remaining = CONNECT_TIMEOUT_MS;
    let startedAt = Date.now();
    let fail: (e: Error) => void = () => {};
    const arm = () => {
      startedAt = Date.now();
      timer = setTimeout(() => {
        // UDP ICE/DTLS still progressing (candidates exchanged, checks in flight): keep waiting on UDP instead of
        // opening a TCP window; the hard cap still bounds it, and "failed" still falls back immediately.
        const st = (this.send as { connectionState?: string } | null)?.connectionState;
        if (st === "connecting" || st === "new") {
          timer = null;
          remaining = ICE_PROGRESS_GRACE_MS;
          arm();
          return;
        }
        fail(new Error("UDP media connection timed out"));
      }, remaining);
    };
    this.budget = {
      pause: () => {
        if (!timer) return;
        clearTimeout(timer);
        timer = null;
        remaining = Math.max(0, remaining - (Date.now() - startedAt));
      },
      resume: () => {
        if (!timer) arm();
      },
    };
    try {
      await Promise.race([
        this.connectInner(withVideo, generation),
        new Promise<never>((_, reject) => {
          fail = reject;
          arm();
          cap = setTimeout(() => reject(new Error("UDP media connection timed out")), CONNECT_HARD_CAP_MS);
        }),
      ]);
    } catch (err) {
      // Close the browser and broker session before the caller asks the server to switch both participants to TCP.
      // Outstanding WebSocket responses are harmless because every post-await path below verifies this generation.
      if (generation === this.generation) this.close();
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      if (cap) clearTimeout(cap);
      this.budget = null;
    }
  }

  /** Run local (non-network) work without spending the UDP connect budget. */
  private async local<T>(work: () => Promise<T>): Promise<T> {
    this.budget?.pause();
    try {
      return await work();
    } finally {
      this.budget?.resume();
    }
  }

  private assertActive(generation: number) {
    if (this.closed || generation !== this.generation) throw new Error("UDP media connection cancelled");
  }

  private async connectInner(withVideo: boolean, generation: number) {
    const { Device } = await this.local(() => import("mediasoup-client"));
    this.assertActive(generation);
    const joined = await this.req<{ ok: boolean; routerRtpCapabilities?: unknown }>("ms:join", {});
    if (!joined.ok || !joined.routerRtpCapabilities) throw new Error("Mediasoup admission failed");
    this.assertActive(generation);
    this.joined = true;
    const device = new Device();
    await device.load({ routerRtpCapabilities: joined.routerRtpCapabilities as Parameters<DeviceLike["load"]>[0]["routerRtpCapabilities"] });
    this.assertActive(generation);
    this.device = device;
    const [sendOpts, recvOpts] = await Promise.all([
      this.req<{ ok: boolean; transport?: Parameters<DeviceLike["createSendTransport"]>[0] }>("ms:transport:create", { direction: "send" }),
      this.req<{ ok: boolean; transport?: Parameters<DeviceLike["createRecvTransport"]>[0] }>("ms:transport:create", { direction: "recv" }),
    ]);
    if (!sendOpts.ok || !sendOpts.transport || !recvOpts.ok || !recvOpts.transport) throw new Error("Mediasoup transport setup failed");
    this.assertActive(generation);
    const send = device.createSendTransport({ ...sendOpts.transport, iceServers: this.media.iceServers ?? [], iceTransportPolicy: "all" });
    const recv = device.createRecvTransport({ ...recvOpts.transport, iceServers: this.media.iceServers ?? [], iceTransportPolicy: "all" });
    this.send = send;
    this.recv = recv;
    this.wireTransport(send, "send");
    this.wireTransport(recv, "recv");
    this.socket.on("ms:consumer:available", this.onAvailable);
    await this.publishAudio(generation);
    if (withVideo) await this.enableCamera("user", generation);
    await this.syncConsumers(generation);
    this.assertActive(generation);
    // Signaling alone succeeds even when UDP is blocked; only report "connected" once ICE/DTLS on the send transport
    // is really up, so a blocked network trips the 8 s connect timeout (→ LiveKit TCP) instead of waiting ~15 s for ICE failure.
    await waitTransportConnected(send);
    this.assertActive(generation);
    this.connected = true;
    this.opts.onState("connected");
  }

  private wireTransport(transport: TransportLike | RecvTransportLike, direction: "send" | "recv") {
    transport.on("connect", ({ dtlsParameters }, callback, errback) => {
      void this.req<{ ok: boolean }>("ms:transport:connect", { direction, transportId: transport.id, dtlsParameters })
        .then((r) => (r.ok ? callback() : errback(new Error("Mediasoup DTLS rejected"))))
        .catch(errback);
    });
    transport.on("connectionstatechange", (state) => {
      if (this.closed) return;
      if (state === "connected") {
        this.iceRestarted.delete(direction);
        // Report recovery after an in-place ICE restart; the initial connect reports through connectInner.
        if (this.connected) this.opts.onState("connected");
        return;
      }
      // First outage on this transport: restart ICE in place (same producers/consumers, no renegotiation) and report
      // "disconnected" so the engine's existing grace timer still falls back to TCP if the restart does not land.
      if (this.connected && shouldRestartIce(state) && !this.iceRestarted.has(direction)) {
        this.iceRestarted.add(direction);
        void this.restartIce(transport, direction);
        this.opts.onState("disconnected");
        return;
      }
      if (state === "failed" || state === "closed") this.opts.onState("failed");
      else if (state === "disconnected") this.opts.onState("disconnected");
    });
    if (direction === "send") {
      (transport as TransportLike).on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
        void this.req<{ ok: boolean; id?: string }>("ms:produce", { transportId: transport.id, kind, rtpParameters, appData })
          .then((r) => (r.ok && r.id ? callback({ id: r.id }) : errback(new Error("Mediasoup producer rejected"))))
          .catch(errback);
      });
    }
  }

  private async restartIce(transport: TransportLike | RecvTransportLike, direction: "send" | "recv") {
    try {
      const r = await this.req<{ ok: boolean; iceParameters?: Parameters<TransportLike["restartIce"]>[0]["iceParameters"] }>(
        "ms:transport:restartIce", { direction, transportId: transport.id },
      );
      if (!r.ok || !r.iceParameters || this.closed) return;
      await transport.restartIce({ iceParameters: r.iceParameters });
    } catch {
      // Older SFU or a dead socket: the engine's disconnected grace timer still switches to the TCP path.
    }
  }

  private async publishAudio(generation?: number) {
    if (!this.send || this.mic) return;
    const stream = await this.local(() => navigator.mediaDevices.getUserMedia({ audio: CALL_AUDIO_CONSTRAINTS }));
    const track = stream.getAudioTracks()[0];
    if (!track || this.closed || (generation !== undefined && generation !== this.generation)) {
      track?.stop();
      return;
    }
    this.mic = track;
    let outbound = track;
    // A suspended destination track is silent on iOS 15 and older Android WebViews. Match the LiveKit path: only
    // build the bounded gain/compressor graph after a user gesture has the shared context running; otherwise retain
    // the browser's raw AEC/NS/AGC microphone with no interruption.
    const rawNativeMic = useRawDirectCallMicrophone({ ua: navigator.userAgent, nativePlatform: nativePlatform() });
    const context = rawNativeMic ? null : audioContext();
    if (context && isAudioContextRunning(context)) {
      const processor = await this.createMicProcessor(context);
      if (processor?.processedTrack) {
        outbound = processor.processedTrack;
        this.micProcessor = processor;
      }
    }
    this.micOutbound = outbound;
    this.micProcessorContext = context;
    const producer = await this.send.produce({
      track: outbound,
      codecOptions: OPUS_VOICE_CODEC_OPTIONS,
      encodings: [{ ...MIC_AUDIO_ENCODING }],
      appData: { source: "microphone" },
    });
    if (this.closed || (generation !== undefined && generation !== this.generation)) {
      producer.close();
      this.micProcessorContext = null;
      await this.micProcessor?.destroy();
      this.micProcessor = null;
      this.micOutbound = null;
      track.stop();
      return;
    }
    this.producers.set("audio", producer);
    // Desktop can restore the processed track after an interruption. Native phone calls publish the raw AEC/NS/AGC
    // microphone throughout, so a stale MediaStreamAudioDestinationNode can never silence a later call.
    context?.addEventListener("statechange", this.onMicAudioState);
    track.addEventListener("ended", this.onMicEnded);
    navigator.mediaDevices.addEventListener?.("devicechange", this.onDeviceChange);
    void navigator.mediaDevices.enumerateDevices?.().then((d) => { this.inputSnapshot ??= inputKeys(d); }).catch(() => {});
    void this.queueMicProcessorSync();
  }

  private async checkMicDevice() {
    if (this.closed || !this.mic) return;
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
    const ids = devices.filter((d) => d.kind === "audioinput" && d.deviceId).map((d) => d.deviceId);
    // Headset follow: a newly connected wired/USB-C/Bluetooth headset also re-acquires so its mic is used.
    const keys = inputKeys(devices), prev = this.inputSnapshot;
    this.inputSnapshot = keys;
    if (micNeedsRecovery(this.mic, ids) || shouldReacquireMic(prev, keys, this.mic.getSettings?.().deviceId).reacquire) await this.recoverMic();
  }

  /**
   * The microphone ended (OS interruption, Bluetooth/headset unplugged, permission blip). Recapture with the same
   * AEC/NS/AGC constraints and swap it into the existing producer: no renegotiation, and mute state is preserved
   * because a paused producer stays paused across replaceTrack.
   */
  recoverMic(): Promise<void> {
    if (this.micRecovering) return this.micRecovering;
    this.micRecovering = (async () => {
      const producer = this.producers.get("audio");
      const old = this.mic;
      if (this.closed || !producer?.replaceTrack || !old) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: CALL_AUDIO_CONSTRAINTS }).catch(() => null);
      const next = stream?.getAudioTracks()[0];
      if (!next) return;
      if (this.closed) return void next.stop();
      try {
        await producer.replaceTrack({ track: next });
      } catch {
        next.stop();
        return;
      }
      old.removeEventListener("ended", this.onMicEnded);
      old.stop();
      const processor = this.micProcessor;
      this.micProcessor = null;
      this.mic = next;
      this.micOutbound = next;
      next.addEventListener("ended", this.onMicEnded);
      await processor?.destroy();
      void this.queueMicProcessorSync();
    })().finally(() => {
      this.micRecovering = null;
    });
    return this.micRecovering;
  }

  private async createMicProcessor(context: AudioContext): Promise<CallVoiceProcessor | null> {
    const raw = this.mic;
    if (!raw || this.closed || !isAudioContextRunning(context)) return null;
    const processor = new CallVoiceProcessor();
    try {
      await processor.init({ track: raw, audioContext: context });
      if (processor.processedTrack && isAudioContextRunning(context) && !this.closed) return processor;
    } catch {
      // The raw AEC/NS/AGC mic remains healthy if Web Audio cannot be created on this engine.
    }
    await processor.destroy();
    return null;
  }

  private queueMicProcessorSync(): Promise<void> {
    this.micProcessorSync = this.micProcessorSync.then(() => this.syncMicProcessor()).catch(() => {});
    return this.micProcessorSync;
  }

  private async syncMicProcessor() {
    const raw = this.mic;
    const producer = this.producers.get("audio");
    const context = this.micProcessorContext;
    if (this.closed || !raw || !producer?.replaceTrack || !context) return;
    if (!isAudioContextRunning(context)) {
      const previous = this.micProcessor;
      if (!previous || this.micOutbound === raw) return;
      try {
        await producer.replaceTrack({ track: raw });
      } catch {
        return; // keep the current track rather than risking a broken sender
      }
      if (this.closed) return;
      this.micProcessor = null;
      this.micOutbound = raw;
      await previous.destroy();
      return;
    }
    if (this.micProcessor || this.micOutbound !== raw) return;
    const next = await this.createMicProcessor(context);
    if (!next?.processedTrack) return;
    try {
      await producer.replaceTrack({ track: next.processedTrack });
    } catch {
      await next.destroy();
      return;
    }
    if (this.closed) {
      await next.destroy();
      return;
    }
    if (!isAudioContextRunning(context)) {
      // The context changed state between graph creation and sender replacement. Put the known-good raw capture
      // back before releasing the processor; never leave a suspended destination published.
      await producer.replaceTrack({ track: raw }).catch(() => {});
      await next.destroy();
      this.micOutbound = raw;
      return;
    }
    this.micProcessor = next;
    this.micOutbound = next.processedTrack;
  }

  async enableCamera(facing: "user" | "environment", generation?: number) {
    if (!this.send || this.camera) return this.camera;
    const tier = browserNetworkTier();
    const stream = await navigator.mediaDevices.getUserMedia({ video: cameraCaptureConstraints(facing, tier) });
    const track = stream.getVideoTracks()[0];
    if (!track || this.closed || (generation !== undefined && generation !== this.generation)) {
      track?.stop();
      return null;
    }
    applyCameraQualityHint(track);
    this.camera = track;
    this.opts.onLocalVideo(track);
    // Restore the proven direct producer path: Mediasoup/browser congestion control can use the camera's healthy
    // native bitrate instead of being pinned to the #41 400 kbps / 24 fps middle layer. Network-tier capture still
    // requests 360p/24 on constrained links, and LiveKit's adaptive fallback remains unchanged.
    const producer = await this.send.produce({ track, appData: { source: "camera" } });
    if (this.closed || (generation !== undefined && generation !== this.generation)) {
      producer.close();
      track.stop();
      this.camera = null;
      this.opts.onLocalVideo(null);
      return null;
    }
    this.producers.set("video", producer);
    return track;
  }

  async disableCamera() {
    this.producers.get("video")?.close();
    this.producers.delete("video");
    this.camera?.stop();
    this.camera = null;
    this.opts.onLocalVideo(null);
  }

  /** Raises or lowers an already-running desktop capture without renegotiation; native WebViews retain their sensor frame. */
  async refreshCameraQuality(facing: "user" | "environment", tier: NetworkTier) {
    return applyCameraCaptureQuality(this.camera, facing, tier);
  }

  async flipCamera(facing: "user" | "environment") {
    if (!this.camera) return this.enableCamera(facing);
    const producer = this.producers.get("video") as { replaceTrack?: (input: { track: MediaStreamTrack }) => Promise<void> } | undefined;
    if (!producer?.replaceTrack) throw new Error("Camera producer unavailable");
    const stream = await navigator.mediaDevices.getUserMedia({ video: cameraCaptureConstraints(facing) });
    const next = stream.getVideoTracks()[0];
    if (!next) {
      for (const candidate of stream.getTracks()) candidate.stop();
      throw new Error("Camera unavailable");
    }
    applyCameraQualityHint(next);
    try {
      await producer.replaceTrack({ track: next });
    } catch (error) {
      // The old producer remains live until replaceTrack succeeds. Release the failed capture so a retry does not
      // contend for the camera on mobile browsers.
      next.stop();
      throw error;
    }
    if (this.closed || this.camera === null) {
      next.stop();
      return null;
    }
    this.camera.stop();
    this.camera = next;
    this.opts.onLocalVideo(next);
    return next;
  }

  async setMuted(muted: boolean) {
    const producer = this.producers.get("audio");
    if (!producer) return;
    if (muted) await producer.pause();
    else await producer.resume();
  }

  /**
   * Native-app ladder (netAdapt.ts): cap Opus and, if a camera producer exists, video resolution/fps/bitrate together.
   * setParameters on the existing senders: no renegotiation, no track swap, no audible gap.
   */
  async applyLadderStep(step: { audioBps: number; videoScale: number; videoFps: number; videoBps: number }): Promise<boolean> {
    if (this.closed) return false;
    const set = async (kind: "audio" | "video", patch: (e: RTCRtpEncodingParameters) => void) => {
      const sender = this.producers.get(kind)?.rtpSender;
      if (!sender?.getParameters || !sender.setParameters) return false;
      try {
        const p = sender.getParameters();
        if (!p.encodings?.length) p.encodings = [{}];
        p.encodings.forEach(patch);
        await sender.setParameters(p);
        return true;
      } catch {
        return false;
      }
    };
    const a = await set("audio", (e) => { e.maxBitrate = step.audioBps; });
    await set("video", (e) => {
      e.maxBitrate = step.videoBps;
      e.maxFramerate = step.videoFps;
      e.scaleResolutionDownBy = step.videoScale;
    });
    return a;
  }

  /** Network changed (Wi-Fi ⇄ cellular, new IP): fresh ICE on both transports in place, producers/consumers kept. */
  async restartIceAll(): Promise<void> {
    if (this.closed) return;
    const pairs: [TransportLike | RecvTransportLike | null, "send" | "recv"][] = [[this.send, "send"], [this.recv, "recv"]];
    await Promise.all(pairs.map(([t, d]) => (t ? this.restartIce(t, d).catch(() => {}) : Promise.resolve())));
  }

  /** Raw transport stats for the engine's quality guard (UDP → TCP on sustained degradation). */
  async getTransportStats(): Promise<RTCStatsReport[]> {
    const out: RTCStatsReport[] = [];
    for (const t of [this.send, this.recv]) {
      const g = (t as unknown as { getStats?: () => Promise<RTCStatsReport> } | null)?.getStats;
      if (g) out.push(await g.call(t).catch(() => new Map() as unknown as RTCStatsReport));
    }
    return out;
  }

  async startAudio() {
    const els = [...document.querySelectorAll<HTMLAudioElement>("[data-ol-call-audio]")];
    await Promise.all(els.map((el) => el.play().catch(() => {})));
    return els.some((el) => !el.paused);
  }

  /**
   * Serialized consumer sync. A notice that lands while a pass is running (e.g. the peer's video producer created right
   * after its audio producer) schedules one more pass instead of being dropped, and callers awaiting a sync (connect)
   * wait for every queued pass, so producers that appeared before or during setup are all consumed and resumed.
   */
  private syncConsumers(generation?: number): Promise<void> {
    if (this.closed || !this.recv || !this.device) return Promise.resolve();
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncDone ?? Promise.resolve();
    }
    this.syncing = true;
    this.syncDone = (async () => {
      try {
        do {
          this.syncAgain = false;
          await this.syncOnce(generation);
        } while (this.syncAgain && !this.closed);
      } finally {
        this.syncing = false;
        this.syncDone = null;
      }
    })();
    return this.syncDone;
  }

  private async syncOnce(generation?: number) {
    if (this.closed || !this.recv || !this.device) return;
    {
      const r = await this.req<{ ok: boolean; consumers?: Array<{ id: string; producerId: string; kind: "audio" | "video"; rtpParameters: unknown }> }>("ms:consume", {
        transportId: this.recv.id,
        rtpCapabilities: this.device.rtpCapabilities,
      });
      if (!r.ok) throw new Error("Mediasoup consumer setup failed");
      for (const params of r.consumers ?? []) {
        if (this.closed || (generation !== undefined && generation !== this.generation) || this.consumers.has(params.id)) continue;
        const consumer = await this.recv.consume(params as Parameters<RecvTransportLike["consume"]>[0]);
        if (this.closed || (generation !== undefined && generation !== this.generation)) {
          consumer.close();
          continue;
        }
        this.consumers.set(consumer.id, consumer);
        this.opts.onRemoteTrack({ kind: consumer.kind, track: consumer.track, close: () => consumer.close(), receiver: (consumer as { rtpReceiver?: RTCRtpReceiver }).rtpReceiver });
        await this.req<{ ok: boolean }>("ms:consumer:resume", { consumerId: consumer.id });
      }
    }
  }

  private req<T>(event: string, data: Record<string, unknown>) {
    return this.socket.request<T>(event, { callId: this.media.callId, ...data }, 8_000);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    const shouldLeave = this.joined && typeof this.media.callId === "string";
    this.joined = false;
    if (shouldLeave) void this.socket.request("ms:leave", { callId: this.media.callId }, 1_000).catch(() => {});
    this.socket.off("ms:consumer:available", this.onAvailable);
    for (const consumer of this.consumers.values()) consumer.close();
    this.consumers.clear();
    for (const producer of this.producers.values()) producer.close();
    this.producers.clear();
    this.send?.close();
    this.recv?.close();
    this.micProcessorContext?.removeEventListener("statechange", this.onMicAudioState);
    this.mic?.removeEventListener("ended", this.onMicEnded);
    if (typeof navigator !== "undefined") navigator.mediaDevices?.removeEventListener?.("devicechange", this.onDeviceChange);
    this.micProcessorContext = null;
    void this.micProcessor?.destroy();
    this.micProcessor = null;
    this.micOutbound = null;
    this.mic?.stop();
    this.camera?.stop();
    this.mic = null;
    this.camera = null;
    this.opts.onLocalVideo(null);
  }
}
