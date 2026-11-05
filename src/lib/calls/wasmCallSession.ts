// Web call leg with no RTCPeerConnection: getUserMedia -> AudioWorklet PCM -> WASM Opus/RTP/SRTP (wasm-call) ->
// WS relay (token pinned to this call's SFU PlainTransport) -> mediasoup, and back. Same session shape as
// NativeMediaSession so the engine/call screens drive it unchanged. Gated by NEXT_PUBLIC_OL_WASM_CALL=1.
import type { RealtimeClient } from "@/lib/realtime";
import type { CallMedia } from "@/lib/types";

const BASE = "/wasm-call";
// tweb@28bba1b src/lib/calls/p2P/connectionRecovery.ts:34-35 and src/lib/calls/constants.ts:33
export const P2P_ICE_RESTART_MIN_INTERVAL_MS = 5000;
export const P2P_ICE_DISCONNECTED_RESTART_DELAY_MS = 2000;
export const CALL_REQUEST_TIMEOUT = 45e3;
export const wasmCallEnabled = () =>
  typeof window !== "undefined" && process.env.NEXT_PUBLIC_OL_WASM_CALL === "1" && typeof AudioWorkletNode !== "undefined" && typeof WebAssembly !== "undefined" &&
  !!navigator.mediaDevices?.getUserMedia && window.isSecureContext !== false; // VideoDecoder optional: no WebCodecs -> audio + send-only video

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
  private decCodec: string | null = null;
  private facing: "user" | "environment" = "user";
  private unlock: (() => void) | null = null;
  private remoteCanvas: HTMLCanvasElement | null = null;
  private remoteTrack: MediaStreamTrack | null = null;
  private haveKey = false;
  private vts = 0;
  private muted = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private wsUrl = "";
  private onPacket: ((e: MessageEvent) => void) | null = null;
  private consume: (() => Promise<void>) | null = null;
  private gotAudio: (() => void) | null = null;
  private hasConnected = false;
  // reconnect state (tweb src/lib/calls/p2P/connectionRecovery.ts)
  private disconnectedTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private failureTimer: ReturnType<typeof setTimeout> | undefined;
  private lastRestartAt: number | undefined;
  private restartCount = 0;
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
    void pickH264Decoder().then((c) => { this.decCodec = c; });
    this.mic = await getMic();
    const { ctx, node } = await openAudioGraph(this.mic);
    this.ctx = ctx; this.unlock = armAudioUnlock(ctx);
    this.wsUrl = `${relayUrl()}/?token=${encodeURIComponent(created.relayToken)}&callId=${encodeURIComponent(String(this.callId))}`;
    // Disabled mic track = silence frames, still sent (as a WebRTC sender does), so the peer's "audio received" gate
    // below also opens for a caller who starts muted.
    node.port.onmessage = (e) => { const ws = this.ws; if (ws?.readyState === 1 && this.core) { ws.send(this.core.send(e.data)); this.stats.sent++; } };
    this.onPacket = (e) => {
      const p = new Uint8Array(e.data as ArrayBuffer); if (!this.core || p.length < 12) return;
      if (p[1] >= 192 && p[1] <= 223) { if (mod.isKeyRequest(p)) this.keyReq = true; return; } // RTCP: PLI/FIR -> IDR next frame
      const pt = p[1] & 0x7f;
      try {
        if (pt === this.vpt) this.onVideoPacket(p);
        else if (this.apt >= 0 && pt === this.apt) { node.port.postMessage(this.core.recv(p)); this.stats.recv++; this.gotAudio?.(); }
        else if (this.apt < 0) { node.port.postMessage(this.core.recv(p)); this.stats.recv++; }
      } catch { this.stats.recvErr++; }
    };
    await this.openMediaWs();
    await this.req("ms:plain:produce", { kind: "audio", ssrc, payloadType: 111 });
    // the peer may produce after us: consume until its audio arrives, and on every availability nudge
    this.consume = async () => { if (this.closed) return; const r = await this.req<{ consumers?: Array<{ kind: string; payloadType: number }> }>("ms:plain:consume").catch(() => null);
      for (const c of r?.consumers ?? []) { if (c.kind === "audio") this.apt = c.payloadType; if (c.kind === "video") this.vpt = c.payloadType; } };
    this.socket.on("ms:consumer:available", this.consume);
    this.poll = setInterval(this.consume, 1000);
    void this.consume();
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    // Connected only once the peer's audio actually arrives (decoded from its consumer's payload type), with our own
    // send path open — telegram-tt reports 'connected' from ontrack + ICE connected (src/lib/vibecalls/phone/
    // phoneCall.ts:524,579); here the equivalent proof is a received packet, not a negotiated consumer. The engine's
    // 12 s connect budget bounds this wait.
    await new Promise<void>((ok) => { this.gotAudio = () => { this.gotAudio = null; ok(); }; });
    if (this.closed) return;
    this.hasConnected = true;
    this.opts.onState("connected");
    if (_withVideo) void this.enableCamera().catch(() => this.opts.onCameraUnavailable?.());
  }

  rebindMic() {}
  checkMicAlive() {}
  async setMuted(muted: boolean) { this.muted = muted; this.mic?.getAudioTracks().forEach((t) => (t.enabled = !muted)); }
  async startAudio() { await this.ctx?.resume().catch(() => {}); return this.ctx?.state === "running"; }
  /** tweb restartIce equivalent for the WASM leg: reopen the media WS to the same relay URL with the same token. The
   *  relay reattaches it to the same UDP socket (ws-media-relay GRACE_MS), so mediasoup's comedia tuple, our SRTP keys,
   *  SSRCs and RTP sequence state all carry on; no server message, no new transport. Only acts while media is down. */
  async restartIceAll() { if (this.mediaDown()) this.requestRestart(0); }

  private mediaDown() { return !this.closed && this.hasConnected && (!this.ws || this.ws.readyState > 1); }

  private openMediaWs(): Promise<void> {
    const ws = (this.ws = new WebSocket(this.wsUrl));
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => { if (this.ws === ws) this.onPacket?.(e); };
    return new Promise<void>((ok, no) => {
      ws.onopen = () => { ws.onclose = () => { if (this.ws === ws) this.onMediaDisconnected(); }; ok(); if (this.hasConnected) this.onMediaRecovered(); };
      ws.onclose = (e) => no(new Error(`relay closed ${e.code}`));
    });
  }

  /** tweb connectionRecovery.ts:165-176 ('disconnected'): restart once the media has been down for 2 s; and
   *  callsController.ts:493-498: a call that had connected and is CONNECTING again arms the 45 s hang-up
   *  (CALL_REQUEST_TIMEOUT, constants.ts:33). The engine shows "Reconnecting…" + loops the tone on "disconnected". */
  private onMediaDisconnected() {
    if (this.closed || !this.hasConnected) return;
    this.opts.onState("disconnected");
    if (this.disconnectedTimer === undefined) this.disconnectedTimer = setTimeout(() => {
      this.disconnectedTimer = undefined;
      if (this.mediaDown()) this.requestRestart(0);
    }, P2P_ICE_DISCONNECTED_RESTART_DELAY_MS);
    if (this.failureTimer === undefined) this.failureTimer = setTimeout(() => {
      this.failureTimer = undefined;
      if (this.mediaDown()) { this.clearRecoveryTimers(); this.opts.onState("failed"); } // engine hangs up
    }, CALL_REQUEST_TIMEOUT);
  }

  /** tweb connectionRecovery.ts:148-163 ('connected'): clear every timer, reset the restart pacing, back to active. */
  private onMediaRecovered() {
    this.clearRecoveryTimers();
    this.lastRestartAt = undefined;
    this.opts.onState("connected");
  }

  /** tweb connectionRecovery.ts requestRestart: never restart more often than P2P_ICE_RESTART_MIN_INTERVAL_MS. */
  private requestRestart(delay: number) {
    if (this.retryTimer !== undefined && delay === 0 && this.lastRestartAt !== undefined) return;
    const sinceLast = this.lastRestartAt === undefined ? Infinity : Date.now() - this.lastRestartAt;
    const wait = Math.max(delay, sinceLast >= P2P_ICE_RESTART_MIN_INTERVAL_MS ? 0 : P2P_ICE_RESTART_MIN_INTERVAL_MS - sinceLast);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.attemptRestart(), wait);
  }

  /** tweb connectionRecovery.ts:312-336 attemptRestart: restart, then re-check after P2P_ICE_RESTART_MIN_INTERVAL_MS
   *  (5 s) and restart again while still down. */
  private attemptRestart() {
    this.retryTimer = undefined;
    if (!this.mediaDown()) return;
    this.lastRestartAt = Date.now();
    this.restartCount++;
    const old = this.ws; if (old) { old.onclose = null; old.onmessage = null; try { old.close(); } catch {} }
    void this.openMediaWs().catch(() => {});
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; if (this.mediaDown()) this.attemptRestart(); }, P2P_ICE_RESTART_MIN_INTERVAL_MS);
  }

  private clearRecoveryTimers() {
    clearTimeout(this.disconnectedTimer); this.disconnectedTimer = undefined;
    clearTimeout(this.retryTimer); this.retryTimer = undefined;
    clearTimeout(this.failureTimer); this.failureTimer = undefined;
  }
  async applyLadderStep(): Promise<boolean> { return false; }
  async getTransportStats(): Promise<RTCStatsReport[]> {
    return [new Map([["wasm", { id: "wasm", type: "wasm-call", packetsSent: this.stats.sent, packetsReceived: this.stats.recv, recvErrors: this.stats.recvErr, videoPacketsSent: this.stats.vSent, framesDecoded: this.stats.vFrames }]]) as unknown as RTCStatsReport];
  }
  private onVideoPacket(p: Uint8Array) {
    const r = this.core!.videoRecv(p); if (!r) return;
    if ("lost" in r) { this.haveKey = false; return; }
    if (r.key) this.haveKey = true; if (!this.haveKey) return;
    if (typeof VideoDecoder === "undefined") return; // audio-only browser: video receive unavailable
    if (!this.dec) {
      const cv = (this.remoteCanvas = document.createElement("canvas")); cv.width = 1280; cv.height = 720;
      const g = cv.getContext("2d")!;
      this.dec = new VideoDecoder({ output: (f) => { if (cv.width !== f.displayWidth) { cv.width = f.displayWidth; cv.height = f.displayHeight; } g.drawImage(f, 0, 0); f.close(); this.stats.vFrames++;
          if (!this.remoteTrack) { const t = (this.remoteTrack = cv.captureStream(30).getVideoTracks()[0]); this.opts.onRemoteTrack?.({ kind: "video", track: t, close: () => t.stop() }); } },
        error: () => { this.haveKey = false; } });
      this.dec.configure({ codec: this.decCodec ?? "avc1.42001f", optimizeForLatency: true });
    }
    this.dec.decode(new EncodedVideoChunk({ type: r.key ? "key" : "delta", timestamp: (this.vts += 33_333), data: r.frame }));
  }

  async enableCamera(facing?: string) {
    if (!this.core || this.closed) return;
    this.stopCamera();
    const prof = sendProfile();
    const cam = (this.cam = await getCamera(facing === "environment" ? "environment" : "user", prof));
    this.facing = facing === "environment" ? "environment" : "user";
    const track = cam.getVideoTracks()[0];
    if (!this.videoProduced) { await this.req("ms:plain:produce", { kind: "video", ssrc: this.vssrc, payloadType: 102 }); this.videoProduced = true; }
    this.opts.onLocalVideo?.(track);
    this.camStop = false;
    // capture -> I420 -> WASM openh264 -> WASM RTP/SRTP (no WebCodecs encode, no RTCPeerConnection)
    const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.srcObject = cam; await v.play().catch(() => {});
    let enc: VEnc | null = null, n = 0, g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null; const t0 = performance.now();
    let encW = 0, encH = 0;
    const tick = () => {
      if (this.camStop || this.closed || !this.core) { enc?.close(); return; }
      const sc = Math.min(1, prof.w / Math.max(1, Math.max(v.videoWidth, v.videoHeight)), prof.h / Math.max(1, Math.min(v.videoWidth, v.videoHeight)) || 1);
      const w = Math.round(v.videoWidth * sc) & ~1, h = Math.round(v.videoHeight * sc) & ~1;
      if (enc && (w !== encW || h !== encH)) { enc.close(); enc = null; } // rotation / camera switch
      if (w > 0 && h > 0) {
        try {
          if (!enc) { enc = this.core.videoEncoder({ width: w, height: h, bitrate: prof.bps, fps: prof.fps, keyIntervalFrames: prof.fps * 2 }); encW = w; encH = h; g = makeCanvas2d(w, h); n = 0; }
          g!.drawImage(v, 0, 0, w, h);
          const ts = performance.now() - t0;
          const r = enc.encode(rgbaToI420(g!.getImageData(0, 0, w, h).data, w, h), Math.round(ts), n++ === 0 || this.keyReq); this.keyReq = false;
          if (r && this.ws?.readyState === 1) for (const pk of this.core.videoSend(r.au, Math.round(ts * 90))) { this.ws.send(pk); this.stats.vSent++; }
        } catch { /* keep going; next frame */ }
      }
      setTimeout(tick, Math.max(0, t0 + n * (1000 / prof.fps) - performance.now()));
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
    if (this.consume) this.socket.off("ms:consumer:available", this.consume);
    this.clearRecoveryTimers(); this.gotAudio?.();
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch {} }
    this.mic?.getTracks().forEach((t) => t.stop());
    this.stopCamera(); try { this.dec?.close(); } catch {} this.remoteTrack?.stop();
    this.unlock?.(); void this.ctx?.close().catch(() => {});
    try { this.core?.close(); } catch {}
    void this.req("ms:leave").catch(() => {});
  }
}

// ---- cross-browser paths (Chrome/Edge/Samsung Internet, Firefox, Safari macOS + iOS, Chrome Android) ----
type AnyWin = typeof window & { webkitAudioContext?: typeof AudioContext };
/** Mic with full voice processing; Firefox/Safari reject some constraint combos -> progressively looser asks. */
async function getMic(): Promise<MediaStream> {
  const asks: MediaStreamConstraints[] = [
    { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } },
    { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } },
    { audio: true },
  ];
  let last: unknown;
  for (const c of asks) { try { return await navigator.mediaDevices.getUserMedia(c); } catch (e) { last = e; if ((e as Error)?.name === "NotAllowedError" || (e as Error)?.name === "NotFoundError") break; } }
  throw last;
}
/** iOS Safari: ask for the call audio session (speaker/earpiece routing + echo cancel), 48 kHz context where allowed.
 *  Firefox can't mix a 48 kHz context with a 44.1 kHz mic -> fall back to the device rate (the worklet resamples). */
async function openAudioGraph(mic: MediaStream): Promise<{ ctx: AudioContext; node: AudioWorkletNode }> {
  try { (navigator as unknown as { audioSession?: { type: string } }).audioSession!.type = "play-and-record"; } catch { /* not Safari */ }
  const AC = window.AudioContext ?? (window as AnyWin).webkitAudioContext!;
  const build = async (opts?: AudioContextOptions) => {
    const ctx = new AC({ latencyHint: "interactive", ...(opts ?? {}) });
    try {
      await ctx.audioWorklet.addModule(`${BASE}/src/pcm-worklet.js`);
      const node = new AudioWorkletNode(ctx, "ol-pcm", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      ctx.createMediaStreamSource(mic).connect(node);
      node.connect(ctx.destination);
      return { ctx, node };
    } catch (e) { void ctx.close().catch(() => {}); throw e; }
  };
  try { return await build({ sampleRate: 48000 }); } catch { return await build(); }
}
/** Autoplay policies (Safari, Chrome Android, Samsung Internet, Firefox): a context created outside a user gesture
 *  starts suspended. Resume on the next tap/key, when the tab comes back, and when iOS interrupts it. */
function armAudioUnlock(ctx: AudioContext): () => void {
  const kick = () => { if (ctx.state !== "running" && ctx.state !== "closed") void ctx.resume().catch(() => {}); };
  const evs = ["pointerdown", "touchend", "keydown", "click"] as const;
  evs.forEach((e) => window.addEventListener(e, kick, { capture: true, passive: true }));
  document.addEventListener("visibilitychange", kick);
  ctx.addEventListener?.("statechange", kick);
  kick();
  return () => { evs.forEach((e) => window.removeEventListener(e, kick, { capture: true })); document.removeEventListener("visibilitychange", kick); ctx.removeEventListener?.("statechange", kick); };
}
type SendProfile = { w: number; h: number; fps: number; bps: number };
/** Phones / low-core devices encode in WASM on the CPU: 640x360@24 there, 1280x720@30 on desktops. */
function sendProfile(): SendProfile {
  const mobile = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const cores = navigator.hardwareConcurrency || 4;
  if (mobile || cores <= 4) return { w: 640, h: 360, fps: 24, bps: 600_000 };
  return { w: 1280, h: 720, fps: 30, bps: 1000 * 1024 }; // Telegram tgcalls v2/InstanceV2Impl.cpp:2141 video max bitrate (olpj 52496ee)
}
async function getCamera(facing: "user" | "environment", p: SendProfile): Promise<MediaStream> {
  const asks: MediaStreamConstraints[] = [
    { video: { facingMode: { ideal: facing }, width: { ideal: p.w }, height: { ideal: p.h }, frameRate: { ideal: p.fps, max: 30 } } },
    { video: { facingMode: facing } },
    { video: true },
  ];
  let last: unknown;
  for (const c of asks) { try { return await navigator.mediaDevices.getUserMedia(c); } catch (e) { last = e; if ((e as Error)?.name === "NotAllowedError") break; } }
  throw last;
}
/** OffscreenCanvas where available (Safari 16.4+, all Chromium, Firefox 105+), else a detached <canvas>. */
function makeCanvas2d(w: number, h: number): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  if (typeof OffscreenCanvas !== "undefined") { const c = new OffscreenCanvas(w, h); const g = c.getContext("2d", { willReadFrequently: true }); if (g) return g as OffscreenCanvasRenderingContext2D; }
  const c = document.createElement("canvas"); c.width = w; c.height = h; return c.getContext("2d", { willReadFrequently: true })!;
}
/** First H.264 decoder profile the browser actually supports (Firefox Android / some Linux builds lack one). */
export async function pickH264Decoder(): Promise<string | null> {
  if (typeof VideoDecoder === "undefined") return null;
  for (const codec of ["avc1.42001f", "avc1.42e01f", "avc1.4d001f", "avc1.640028"]) {
    try { if ((await VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true })).supported) return codec; } catch { /* next */ }
  }
  return null;
}
