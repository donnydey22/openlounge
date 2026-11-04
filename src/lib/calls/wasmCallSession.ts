// Web call leg with no RTCPeerConnection: getUserMedia -> AudioWorklet PCM -> WASM Opus/RTP/SRTP (wasm-call) ->
// WS relay (token pinned to this call's SFU PlainTransport) -> mediasoup, and back. Same session shape as
// NativeMediaSession so the engine/call screens drive it unchanged. Gated by NEXT_PUBLIC_OL_WASM_CALL=1.
import type { RealtimeClient } from "@/lib/realtime";
import type { CallMedia } from "@/lib/types";

const BASE = "/wasm-call";
export const wasmCallEnabled = () =>
  typeof window !== "undefined" && process.env.NEXT_PUBLIC_OL_WASM_CALL === "1" && typeof AudioWorkletNode !== "undefined" && typeof WebAssembly !== "undefined" && typeof VideoDecoder !== "undefined";

type Core = { send(pcm: Float32Array | Int16Array): Uint8Array; recv(p: Uint8Array): Float32Array | Int16Array; close(): void };
type Opts = {
  onState(state: "connected" | "disconnected" | "failed"): void;
  onRemoteTrack?(t: { kind: "audio" | "video"; track: MediaStreamTrack; close: () => void }): void;
  onLocalVideo?(track: MediaStreamTrack | null): void;
  onCameraUnavailable?(): void;
  callId?: string;
  [k: string]: unknown;
};
type VEnc = { encode(i420: Uint8Array, tsMs: number, key: boolean): { au: Uint8Array; key: boolean } | null; close(): void };
type VCore = Core & { openVideo(o: { ssrc: number; pt?: number }): void; videoEncoder(o: { width: number; height: number; bitrate?: number; fps?: number; keyIntervalFrames?: number }): VEnc;
  videoSend(au: Uint8Array, ts90k: number): Uint8Array[]; videoRecv(p: Uint8Array): { frame: Uint8Array; key: boolean } | { lost: true } | null };

function rgbaToI420(d: Uint8ClampedArray, w: number, h: number) {
  const o = new Uint8Array((w * h * 3) / 2), U = w * h, V = U + U / 4;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; o[y * w + x] = (66 * d[i] + 129 * d[i + 1] + 25 * d[i + 2] + 4224) >> 8;
    if (!(x & 1) && !(y & 1)) { const c = (y >> 1) * (w >> 1) + (x >> 1); o[U + c] = (-38 * d[i] - 74 * d[i + 1] + 112 * d[i + 2] + 32896) >> 8; o[V + c] = (112 * d[i] - 94 * d[i + 1] - 18 * d[i + 2] + 32896) >> 8; } }
  return o;
}

const relayUrl = () => {
  const env = process.env.NEXT_PUBLIC_OL_WS_RELAY;
  return env || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/media-relay`;
};

// Fetch + compile the WASM core once per page (prewarmed when a call screen opens, reused by every session/retry).
type Loaded = { mod: any; factory: unknown }; // eslint-disable-line @typescript-eslint/no-explicit-any
let loading: Promise<Loaded> | null = null;
export function prewarmWasmCall(): Promise<Loaded> {
  if (!loading) loading = (async () => {
    const mod = await import(/* webpackIgnore: true */ `${BASE}/src/client.mjs` as string);
    const factory = (await import(/* webpackIgnore: true */ `${BASE}/dist/olwasm.mjs` as string)).default;
    return { mod, factory };
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

export class WasmCallSession {
  private closed = false;
  private ws: WebSocket | null = null;
  private mic: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private core: VCore | null = null;
  private vssrc = 5_000_000 + Math.floor(Math.random() * 1e6);
  private videoProduced = false;
  private cam: MediaStream | null = null;
  private camStop = false;
  private keyReq = false;
  private vpt = -1;
  private apt = -1;
  private dec: VideoDecoder | null = null;
  private remoteCanvas: HTMLCanvasElement | null = null;
  private remoteTrack: MediaStreamTrack | null = null;
  private haveKey = false;
  private vts = 0;
  private muted = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private stats = { sent: 0, recv: 0, recvErr: 0, vSent: 0, vFrames: 0 };

  constructor(private socket: RealtimeClient, private media: CallMedia, private opts: Opts) { void prewarmWasmCall().catch(() => {}); }

  private get callId() { return (this.media as CallMedia & { callId?: string }).callId ?? this.opts.callId; }
  private req<T>(event: string, data: Record<string, unknown> = {}) {
    return this.socket.request<T>(event, { callId: this.callId, ...data }, 8_000);
  }

  async connect(_withVideo: boolean) {
    const [{ mod, factory }] = await Promise.all([prewarmWasmCall(), this.req("ms:join")]);
    const created = await this.req<{ ip: string; port: number; srtpParameters: { keyBase64: string }; relayToken?: string }>("ms:plain:create");
    if (!created?.relayToken) throw new Error("wasm call: no relay token");
    const tx: string = mod.newKeyB64();
    await this.req("ms:plain:connect", { srtpParameters: { cryptoSuite: "AES_CM_128_HMAC_SHA1_80", keyBase64: tx } });
    const ssrc = 1000 + Math.floor(Math.random() * 1e6);
    this.core = (await mod.MediaCore.load(factory)).open({ txKeyB64: tx, rxKeyB64: created.srtpParameters.keyBase64, ssrc });
    this.core!.openVideo({ ssrc: this.vssrc, pt: 102 });
    this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    this.ctx = new AudioContext({ sampleRate: 48000 });
    await this.ctx.audioWorklet.addModule(`${BASE}/src/pcm-worklet.js`);
    const node = new AudioWorkletNode(this.ctx, "ol-pcm");
    this.ctx.createMediaStreamSource(this.mic).connect(node);
    node.connect(this.ctx.destination);
    const ws = (this.ws = new WebSocket(`${relayUrl()}/?token=${encodeURIComponent(created.relayToken)}&callId=${encodeURIComponent(String(this.callId))}`));
    ws.binaryType = "arraybuffer";
    await new Promise<void>((ok, no) => { ws.onopen = () => ok(); ws.onclose = (e) => no(new Error(`relay closed ${e.code}`)); });
    ws.onclose = () => { if (!this.closed) this.opts.onState("disconnected"); };
    node.port.onmessage = (e) => { if (!this.muted && ws.readyState === 1 && this.core) { ws.send(this.core.send(e.data)); this.stats.sent++; } };
    ws.onmessage = (e) => {
      const p = new Uint8Array(e.data as ArrayBuffer); if (!this.core || p.length < 12) return;
      if (p[1] >= 192 && p[1] <= 223) { if (mod.isKeyRequest(p)) this.keyReq = true; return; } // RTCP: PLI/FIR -> IDR next frame
      const pt = p[1] & 0x7f;
      try {
        if (pt === this.vpt) this.onVideoPacket(p);
        else if (this.apt < 0 || pt === this.apt) { node.port.postMessage(this.core.recv(p)); this.stats.recv++; }
      } catch { this.stats.recvErr++; }
    };
    await this.req("ms:plain:produce", { kind: "audio", ssrc, payloadType: 111 });
    // the peer may produce after us: consume until its audio arrives, and on every availability nudge
    let have = false;
    const consume = async () => { if (this.closed) return; const r = await this.req<{ consumers?: Array<{ kind: string; payloadType: number }> }>("ms:plain:consume").catch(() => null);
      for (const c of r?.consumers ?? []) { if (c.kind === "audio") { this.apt = c.payloadType; have = true; } if (c.kind === "video") this.vpt = c.payloadType; } };
    this.socket.on("ms:consumer:available", consume);
    this.poll = setInterval(consume, 1000);
    void consume();
    void have;
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    this.opts.onState("connected");
    if (_withVideo) void this.enableCamera().catch(() => this.opts.onCameraUnavailable?.());
  }

  rebindMic() {}
  checkMicAlive() {}
  async setMuted(muted: boolean) { this.muted = muted; this.mic?.getAudioTracks().forEach((t) => (t.enabled = !muted)); }
  async startAudio() { await this.ctx?.resume().catch(() => {}); return this.ctx?.state === "running"; }
  async restartIceAll() {}
  async applyLadderStep(): Promise<boolean> { return false; }
  async getTransportStats(): Promise<RTCStatsReport[]> {
    return [new Map([["wasm", { id: "wasm", type: "wasm-call", packetsSent: this.stats.sent, packetsReceived: this.stats.recv, recvErrors: this.stats.recvErr, videoPacketsSent: this.stats.vSent, framesDecoded: this.stats.vFrames }]]) as unknown as RTCStatsReport];
  }
  private onVideoPacket(p: Uint8Array) {
    const r = this.core!.videoRecv(p); if (!r) return;
    if ("lost" in r) { this.haveKey = false; return; }
    if (r.key) this.haveKey = true; if (!this.haveKey) return;
    if (!this.dec) {
      const cv = (this.remoteCanvas = document.createElement("canvas")); cv.width = 1280; cv.height = 720;
      const g = cv.getContext("2d")!;
      this.dec = new VideoDecoder({ output: (f) => { if (cv.width !== f.displayWidth) { cv.width = f.displayWidth; cv.height = f.displayHeight; } g.drawImage(f, 0, 0); f.close(); this.stats.vFrames++;
          if (!this.remoteTrack) { const t = (this.remoteTrack = cv.captureStream(30).getVideoTracks()[0]); this.opts.onRemoteTrack?.({ kind: "video", track: t, close: () => t.stop() }); } },
        error: () => { this.haveKey = false; } });
      this.dec.configure({ codec: "avc1.42001f", optimizeForLatency: true });
    }
    this.dec.decode(new EncodedVideoChunk({ type: r.key ? "key" : "delta", timestamp: (this.vts += 33_333), data: r.frame }));
  }

  async enableCamera(facing?: string) {
    if (!this.core || this.closed) return;
    this.stopCamera();
    const cam = (this.cam = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing === "environment" ? "environment" : "user", width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: 30 } }));
    const track = cam.getVideoTracks()[0];
    if (!this.videoProduced) { await this.req("ms:plain:produce", { kind: "video", ssrc: this.vssrc, payloadType: 102 }); this.videoProduced = true; }
    this.opts.onLocalVideo?.(track);
    this.camStop = false;
    // capture -> I420 -> WASM openh264 -> WASM RTP/SRTP (no WebCodecs encode, no RTCPeerConnection)
    const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.srcObject = cam; await v.play().catch(() => {});
    let enc: VEnc | null = null, n = 0, cv: OffscreenCanvas | null = null, g: OffscreenCanvasRenderingContext2D | null = null; const t0 = performance.now();
    const tick = () => {
      if (this.camStop || this.closed || !this.core) { enc?.close(); return; }
      const w = Math.min(1280, v.videoWidth) & ~1, h = Math.min(720, v.videoHeight) & ~1;
      if (w > 0 && h > 0) {
        try {
          if (!enc) { enc = this.core.videoEncoder({ width: w, height: h, bitrate: 900_000, fps: 30, keyIntervalFrames: 60 }); cv = new OffscreenCanvas(w, h); g = cv.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D; }
          g!.drawImage(v, 0, 0, w, h);
          const ts = performance.now() - t0;
          const r = enc.encode(rgbaToI420(g!.getImageData(0, 0, w, h).data, w, h), Math.round(ts), n++ === 0 || this.keyReq); this.keyReq = false;
          if (r && this.ws?.readyState === 1) for (const pk of this.core.videoSend(r.au, Math.round(ts * 90))) { this.ws.send(pk); this.stats.vSent++; }
        } catch { /* keep going; next frame */ }
      }
      setTimeout(tick, Math.max(0, t0 + n * (1000 / 30) - performance.now()));
    };
    tick();
  }
  private stopCamera() { this.camStop = true; this.cam?.getTracks().forEach((t) => t.stop()); this.cam = null; }
  async disableCamera() { this.stopCamera(); this.opts.onLocalVideo?.(null); }
  async refreshCameraQuality() { return false; }
  async flipCamera(facing?: string) { await this.enableCamera(facing); }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    try { this.ws?.close(); } catch {}
    this.mic?.getTracks().forEach((t) => t.stop());
    this.stopCamera(); try { this.dec?.close(); } catch {} this.remoteTrack?.stop();
    void this.ctx?.close().catch(() => {});
    try { this.core?.close(); } catch {}
    void this.req("ms:leave").catch(() => {});
  }
}
