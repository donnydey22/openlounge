import type { CallMedia } from "@/lib/types";
import type { RealtimeClient } from "@/lib/realtime";

export type MediasoupRemoteTrack = { kind: "audio" | "video"; track: MediaStreamTrack; close: () => void };

type DeviceLike = InstanceType<typeof import("mediasoup-client").Device>;
type TransportLike = ReturnType<DeviceLike["createSendTransport"]>;
type RecvTransportLike = ReturnType<DeviceLike["createRecvTransport"]>;

const MIC: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const CONNECT_TIMEOUT_MS = 4_000;

/**
 * Browser half of the brokered Mediasoup protocol. The only network API used here is the app's authenticated
 * RealtimeClient; the SFU control connection and its long-lived secret stay server-side.
 */
export class MediasoupCallSession {
  private device: DeviceLike | null = null;
  private send: TransportLike | null = null;
  private recv: RecvTransportLike | null = null;
  private mic: MediaStreamTrack | null = null;
  private camera: MediaStreamTrack | null = null;
  private consumers = new Map<string, { close(): void; track: MediaStreamTrack }>();
  private producers = new Map<"audio" | "video", { close(): void; pause(): void | Promise<void>; resume(): void | Promise<void> }>();
  private closed = false;
  private syncing = false;
  /** A consumer:available notice arrived while a sync was in flight; run another pass so late producers are never dropped. */
  private syncAgain = false;
  private syncDone: Promise<void> | null = null;
  private connected = false;
  private joined = false;
  private generation = 0;
  private readonly onAvailable = () => void this.syncConsumers().catch(() => {});

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

  async connect(withVideo: boolean) {
    const generation = ++this.generation;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.connectInner(withVideo, generation),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("UDP media connection timed out")), CONNECT_TIMEOUT_MS))),
      ]);
    } catch (err) {
      // Close the browser and broker session before the caller asks the server to switch both participants to TCP.
      // Outstanding WebSocket responses are harmless because every post-await path below verifies this generation.
      if (generation === this.generation) this.close();
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private assertActive(generation: number) {
    if (this.closed || generation !== this.generation) throw new Error("UDP media connection cancelled");
  }

  private async connectInner(withVideo: boolean, generation: number) {
    const { Device } = await import("mediasoup-client");
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
      if (state === "connected") return;
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

  private async publishAudio(generation?: number) {
    if (!this.send || this.mic) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC });
    const track = stream.getAudioTracks()[0];
    if (!track || this.closed || (generation !== undefined && generation !== this.generation)) {
      track?.stop();
      return;
    }
    this.mic = track;
    const producer = await this.send.produce({ track, appData: { source: "microphone" } });
    if (this.closed || (generation !== undefined && generation !== this.generation)) {
      producer.close();
      track.stop();
      return;
    }
    this.producers.set("audio", producer);
  }

  async enableCamera(facing: "user" | "environment", generation?: number) {
    if (!this.send || this.camera) return this.camera;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } });
    const track = stream.getVideoTracks()[0];
    if (!track || this.closed || (generation !== undefined && generation !== this.generation)) {
      track?.stop();
      return null;
    }
    this.camera = track;
    this.opts.onLocalVideo(track);
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

  async flipCamera(facing: "user" | "environment") {
    if (!this.camera) return this.enableCamera(facing);
    const producer = this.producers.get("video") as { replaceTrack?: (input: { track: MediaStreamTrack }) => Promise<void> } | undefined;
    if (!producer?.replaceTrack) throw new Error("Camera producer unavailable");
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing } });
    const next = stream.getVideoTracks()[0];
    if (!next) throw new Error("Camera unavailable");
    await producer.replaceTrack({ track: next });
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
        this.opts.onRemoteTrack({ kind: consumer.kind, track: consumer.track, close: () => consumer.close() });
        await this.req<{ ok: boolean }>("ms:consumer:resume", { consumerId: consumer.id });
      }
    }
  }

  private req<T>(event: string, data: Record<string, unknown>) {
    return this.socket.request<T>(event, { callId: this.media.callId, ...data }, 4_000);
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
    this.mic?.stop();
    this.camera?.stop();
    this.mic = null;
    this.camera = null;
    this.opts.onLocalVideo(null);
  }
}
