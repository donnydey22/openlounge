// Web call leg with no RTCPeerConnection: getUserMedia -> AudioWorklet PCM -> WASM Opus/RTP/SRTP (wasm-call) ->
// WS relay (token pinned to this call's SFU PlainTransport) -> mediasoup, and back. Same session shape as
// NativeMediaSession so the engine/call screens drive it unchanged. Gated by NEXT_PUBLIC_OL_WASM_CALL=1.
import type { RealtimeClient } from "@/lib/realtime";
import type { CallMedia } from "@/lib/types";

const BASE = "/wasm-call";
export const wasmCallEnabled = () =>
  typeof window !== "undefined" && process.env.NEXT_PUBLIC_OL_WASM_CALL === "1" && typeof AudioWorkletNode !== "undefined" && typeof WebAssembly !== "undefined";

type Core = { send(pcm: Float32Array | Int16Array): Uint8Array; recv(p: Uint8Array): Float32Array | Int16Array; close(): void };
type Opts = { onState(state: "connected" | "disconnected" | "failed"): void; callId?: string; [k: string]: unknown };

const relayUrl = () => {
  const env = process.env.NEXT_PUBLIC_OL_WS_RELAY;
  return env || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/media-relay`;
};

export class WasmCallSession {
  private closed = false;
  private ws: WebSocket | null = null;
  private mic: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private core: Core | null = null;
  private muted = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private stats = { sent: 0, recv: 0, recvErr: 0 };

  constructor(private socket: RealtimeClient, private media: CallMedia, private opts: Opts) {}

  private get callId() { return (this.media as CallMedia & { callId?: string }).callId ?? this.opts.callId; }
  private req<T>(event: string, data: Record<string, unknown> = {}) {
    return this.socket.request<T>(event, { callId: this.callId, ...data }, 8_000);
  }

  async connect(_withVideo: boolean) {
    const mod = await import(/* webpackIgnore: true */ `${BASE}/src/client.mjs` as string);
    const factory = (await import(/* webpackIgnore: true */ `${BASE}/dist/olwasm.mjs` as string)).default;
    await this.req("ms:join");
    const created = await this.req<{ ip: string; port: number; srtpParameters: { keyBase64: string }; relayToken?: string }>("ms:plain:create");
    if (!created?.relayToken) throw new Error("wasm call: no relay token");
    const tx: string = mod.newKeyB64();
    await this.req("ms:plain:connect", { srtpParameters: { cryptoSuite: "AES_CM_128_HMAC_SHA1_80", keyBase64: tx } });
    const ssrc = 1000 + Math.floor(Math.random() * 1e6);
    this.core = (await mod.MediaCore.load(factory)).open({ txKeyB64: tx, rxKeyB64: created.srtpParameters.keyBase64, ssrc });
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
    ws.onmessage = (e) => { try { if (this.core) { node.port.postMessage(this.core.recv(new Uint8Array(e.data as ArrayBuffer))); this.stats.recv++; } } catch { this.stats.recvErr++; } };
    await this.req("ms:plain:produce", { kind: "audio", ssrc, payloadType: 111 });
    // the peer may produce after us: consume until its audio arrives, and on every availability nudge
    let have = false;
    const consume = async () => { if (have || this.closed) return; const r = await this.req<{ consumers?: Array<{ kind: string }> }>("ms:plain:consume").catch(() => null);
      if (r?.consumers?.some((c) => c.kind === "audio")) { have = true; if (this.poll) clearInterval(this.poll); this.poll = null; } };
    this.socket.on("ms:consumer:available", consume);
    this.poll = setInterval(consume, 1000);
    await consume();
    if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => {});
    this.opts.onState("connected");
  }

  rebindMic() {}
  checkMicAlive() {}
  async setMuted(muted: boolean) { this.muted = muted; this.mic?.getAudioTracks().forEach((t) => (t.enabled = !muted)); }
  async startAudio() { await this.ctx?.resume().catch(() => {}); return this.ctx?.state === "running"; }
  async restartIceAll() {}
  async applyLadderStep(): Promise<boolean> { return false; }
  async getTransportStats(): Promise<RTCStatsReport[]> {
    return [new Map([["wasm", { id: "wasm", type: "wasm-call", packetsSent: this.stats.sent, packetsReceived: this.stats.recv, recvErrors: this.stats.recvErr }]]) as unknown as RTCStatsReport];
  }
  async enableCamera() { throw new Error("wasm call: video not wired yet"); }
  async disableCamera() {}
  async refreshCameraQuality() { return false; }
  async flipCamera() {}

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    try { this.ws?.close(); } catch {}
    this.mic?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    try { this.core?.close(); } catch {}
    void this.req("ms:leave").catch(() => {});
  }
}
