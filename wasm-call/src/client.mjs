// Browser call client (PLAN §9). getUserMedia = capture only; AudioWorklet moves raw PCM; olwasm does Opus+RTP+SRTP;
// SRTP packets ride one binary WS frame each to ws-media-relay -> mediasoup PlainTransport. Signaling = the same
// call-signal protocol as phones (call:new/accept/offer/answer/sfu:plain/leave) with a=crypto in the SDP.
export function cryptoLine(keyB64) { return `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${keyB64}`; }
export function parseCrypto(sdp) { const m = /a=crypto:\d+ AES_CM_128_HMAC_SHA1_80 inline:([A-Za-z0-9+/=]{40})/.exec(sdp); return m ? m[1] : null; }
export function newKeyB64() { const k = new Uint8Array(30); crypto.getRandomValues(k); return btoa(String.fromCharCode(...k)); }
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export function audioOfferSdp({ keyB64, ssrc }) {
  return ["v=0", "o=- 0 0 IN IP4 0.0.0.0", "s=ol", "c=IN IP4 0.0.0.0", "t=0 0", "m=audio 9 RTP/SAVP 111", "a=rtpmap:111 opus/48000/2",
    "a=fmtp:111 useinbandfec=1;minptime=10", "a=rtcp-mux", `a=ssrc:${ssrc} cname:ol-web`, cryptoLine(keyB64), "a=sendrecv", ""].join("\r\n");
}
export class MediaCore {
  static async load(factory) { const M = await factory(); M._ol_init(); return new MediaCore(M); }
  constructor(M) { this.M = M; this.pcm = M._malloc(1920); this.buf = M._malloc(1500); }
  open({ txKeyB64, rxKeyB64, ssrc, pt = 111 }) {
    const M = this.M, tx = M._malloc(30), rx = M._malloc(30); M.HEAPU8.set(b64(txKeyB64), tx); M.HEAPU8.set(b64(rxKeyB64), rx);
    this.c = M._ol_call_new(tx, rx, ssrc >>> 0, pt); M._free(tx); M._free(rx); if (!this.c) throw new Error("ol_call_new"); return this;
  }
  /** Int16Array(960) -> Uint8Array SRTP packet */
  send(pcm16) { const M = this.M; M.HEAP16.set(pcm16, this.pcm >> 1); const n = M._ol_send(this.c, this.pcm, this.buf); if (n < 0) throw new Error(`send ${n}`); return M.HEAPU8.slice(this.buf, this.buf + n); }
  /** SRTP packet (or null for loss -> PLC) -> Int16Array(960) */
  recv(pkt) { const M = this.M; if (pkt) M.HEAPU8.set(pkt, this.buf); const n = M._ol_recv(this.c, this.buf, pkt ? pkt.length : 0, this.pcm, pkt ? 0 : 1);
    if (n < 0) throw new Error(`recv ${n}`); return M.HEAP16.slice(this.pcm >> 1, (this.pcm >> 1) + n); }
  /** Video on the same SRTP leg (H.264 RTP in WASM; WebCodecs does encode/decode). */
  openVideo({ ssrc, pt = 102 }) { const M = this.M; M._ol_video_init(this.c, ssrc >>> 0, pt); this.vout = M._malloc(64 * 1500); this.vlens = M._malloc(64 * 4); this.vframe = M._malloc(1 << 20); this.vkey = M._malloc(4); this.vin = M._malloc(1 << 20); return this; }
  /** Annex-B access unit + 90 kHz ts -> SRTP packets */
  videoSend(au, ts90k) { const M = this.M; M.HEAPU8.set(au, this.vin); const n = M._ol_video_send(this.c, this.vin, au.length, ts90k >>> 0, this.vout, this.vlens, 64);
    if (n < 0) throw new Error(`vsend ${n}`); const out = []; for (let i = 0; i < n; i++) { const l = M.HEAP32[(this.vlens >> 2) + i]; out.push(M.HEAPU8.slice(this.vout + i * 1500, this.vout + i * 1500 + l)); } return out; }
  /** SRTP video packet -> {frame, key} when an access unit completes, null while assembling, {lost:true} on a gap */
  videoRecv(pkt) { const M = this.M; M.HEAPU8.set(pkt, this.buf); const n = M._ol_video_recv(this.c, this.buf, pkt.length, this.vframe, this.vkey);
    if (n === -102) return { lost: true }; if (n < 0) throw new Error(`vrecv ${n}`); if (n === 0) return null;
    return { frame: M.HEAPU8.slice(this.vframe, this.vframe + n), key: M.HEAP32[this.vkey >> 2] === 1 }; }
  /** WASM H.264 encoder (openh264), single layer, <=1280x720 (PLAN §14 browser). Returns {encode(i420, tsMs, key) -> {au, key}|null, close}. */
  videoEncoder({ width, height, bitrate = 800_000, fps = 30, keyIntervalFrames = 60 }) { const M = this.M;
    const e = M._ol_venc_new(width, height, bitrate, fps, keyIntervalFrames); if (!e) throw new Error(`venc init ${width}x${height}`);
    const inp = M._malloc(width * height * 3 / 2), out = M._malloc(1 << 20), key = M._malloc(4);
    return { encode: (i420, tsMs, forceKey = false) => { M.HEAPU8.set(i420, inp); const n = M._ol_venc_encode(e, inp, tsMs >>> 0, forceKey ? 1 : 0, out, 1 << 20, key);
        if (n < 0) throw new Error(`venc ${n}`); return n === 0 ? null : { au: M.HEAPU8.slice(out, out + n), key: M.HEAP32[key >> 2] === 1 }; },
      close: () => { M._ol_venc_free(e); M._free(inp); M._free(out); M._free(key); } }; }
  close() { if (this.c) this.M._ol_call_free(this.c); this.c = 0; }
}
/** Wire a live call: mic (capture only) -> worklet -> core -> WS relay -> core -> worklet -> speaker. */
export async function startBrowserCall({ factory, relayUrl, txKeyB64, rxKeyB64, ssrc, workletUrl }) {
  const core = (await MediaCore.load(factory)).open({ txKeyB64, rxKeyB64, ssrc });
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000, channelCount: 1 } });
  const ctx = new AudioContext({ sampleRate: 48000 }); await ctx.audioWorklet.addModule(workletUrl);
  const node = new AudioWorkletNode(ctx, "ol-pcm"); ctx.createMediaStreamSource(mic).connect(node); node.connect(ctx.destination);
  const ws = new WebSocket(relayUrl); ws.binaryType = "arraybuffer";
  node.port.onmessage = (e) => { if (ws.readyState === 1) ws.send(core.send(e.data)); };
  ws.onmessage = (e) => { try { node.port.postMessage(core.recv(new Uint8Array(e.data))); } catch {} };
  return { hangup() { ws.close(); mic.getTracks().forEach((t) => t.stop()); ctx.close(); core.close(); } };
}
