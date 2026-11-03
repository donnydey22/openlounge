// Browser leg for the matrix: getUserMedia (capture only) -> AudioWorklet PCM / MediaStreamTrackProcessor frames ->
// WASM Opus or WebCodecs H.264 encode -> WASM RTP+SRTP -> WS relay -> mediasoup PlainTransport -> back the same way.
// No RTCPeerConnection anywhere. window.olCall(opts) resolves with measured receive stats.
import factory from "/wasm-call/dist/olwasm.mjs";
import { MediaCore, newKeyB64 } from "/wasm-call/src/client.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (callId, userId, method, payload = {}) => { const r = await fetch("/rpc", { method: "POST", body: JSON.stringify({ callId, userId, method, payload }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };

window.olSignal = (userId) => new Promise((ok) => { const ws = new WebSocket(`${location.origin.replace("http", "ws")}/signal?token=${userId}`);
  const box = { ws, msgs: [], wait: async (t) => { for (let i = 0; i < 300; i++) { const m = box.msgs.find((x) => x.t === t); if (m) { box.msgs.splice(box.msgs.indexOf(m), 1); return m; } await sleep(100); } throw new Error(`no ${t}`); },
    send: (m) => ws.send(JSON.stringify(m)) };
  ws.onmessage = (e) => box.msgs.push(JSON.parse(e.data)); ws.onopen = () => { window.__sig = box; ok(true); }; });

window.olCall = async ({ callId, userId, relayUrl, video, seconds = 30 }) => {
  const stats = { audioPkts: 0, audioRms: 0, rmsN: 0, videoFrames: 0, videoKey: 0, nonBlack: 0, srtpErr: 0, decodeErr: 0, sent: 0 };
  const created = await rpc(callId, userId, "plain:create");
  const tx = newKeyB64();
  await rpc(callId, userId, "plain:connect", { srtpParameters: { cryptoSuite: "AES_CM_128_HMAC_SHA1_80", keyBase64: tx } });
  const assrc = 1000 + Math.floor(Math.random() * 1e6);
  const core = (await MediaCore.load(factory)).open({ txKeyB64: tx, rxKeyB64: created.srtpParameters.keyBase64, ssrc: assrc });
  const vssrc = 5_000_000 + Math.floor(Math.random() * 1e6); if (video) core.openVideo({ ssrc: vssrc, pt: 102 });
  const ws = new WebSocket(`${relayUrl}/?token=${userId}&callId=${callId}`); ws.binaryType = "arraybuffer";
  await new Promise((ok, no) => { ws.onopen = ok; ws.onclose = (e) => no(new Error(`relay closed ${e.code}`)); });
  const send = (p) => { if (ws.readyState === 1) { ws.send(p); stats.sent++; } };
  // capture (getUserMedia only)
  const ms = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: video ? { width: 640, height: 480, frameRate: 30 } : false });
  const ctx = new AudioContext({ sampleRate: 48000 }); await ctx.audioWorklet.addModule("/wasm-call/src/pcm-worklet.js");
  const node = new AudioWorkletNode(ctx, "ol-pcm"); ctx.createMediaStreamSource(ms).connect(node); node.connect(ctx.destination);
  let live = true; node.port.onmessage = (e) => { if (live) send(core.send(e.data)); };
  await rpc(callId, userId, "plain:produce", { kind: "audio", ssrc: assrc, payloadType: 111 });
  let enc, reader, encStop = false;
  if (video) {
    await rpc(callId, userId, "plain:produce", { kind: "video", ssrc: vssrc, payloadType: 102 });
    let n = 0; enc = new VideoEncoder({ output: (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); for (const p of core.videoSend(b, Math.round(chunk.timestamp * 0.09))) send(p); }, error: () => stats.decodeErr++ });
    enc.configure({ codec: "avc1.42001f", width: 640, height: 480, bitrate: 800_000, framerate: 30, latencyMode: "realtime", avc: { format: "annexb" } });
    reader = new MediaStreamTrackProcessor({ track: ms.getVideoTracks()[0] }).readable.getReader();
    (async () => { while (!encStop) { const { value, done } = await reader.read(); if (done) break; if (enc.encodeQueueSize < 3) enc.encode(value, { keyFrame: n++ % 30 === 0 }); value.close(); } })();
  }
  // consume the peer (poll until its producers exist)
  let consumers = [];
  for (let i = 0; i < 100 && consumers.length < (video ? 2 : 1); i++) { consumers = consumers.concat((await rpc(callId, userId, "plain:consume")).consumers); await sleep(200); }
  const vpt = consumers.find((c) => c.kind === "video")?.payloadType, apt = consumers.find((c) => c.kind === "audio")?.payloadType;
  const canvas = new OffscreenCanvas(64, 48); const g = canvas.getContext("2d", { willReadFrequently: true });
  const dec = video ? new VideoDecoder({ output: (f) => { if (!stats.firstFrameAt) stats.firstFrameAt = performance.now(); stats.videoFrames++; if (stats.videoFrames % 10 === 0) { g.drawImage(f, 0, 0, 64, 48); const d = g.getImageData(0, 0, 64, 48).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; if (s / (d.length / 4) / 3 > 16) stats.nonBlack++; } f.close(); }, error: () => stats.decodeErr++ }) : null;
  dec?.configure({ codec: "avc1.42001f", optimizeForLatency: true });
  let haveKey = false, t0 = 0;
  ws.onmessage = (e) => { const p = new Uint8Array(e.data); if (p[1] >= 192 && p[1] <= 223) return; /* RTCP */ const pt = p[1] & 0x7f;
    try {
      if (video && pt === vpt) { const r = core.videoRecv(p); if (!r) return; if (r.lost) { haveKey = false; return; } if (r.key) { haveKey = true; stats.videoKey++; } if (!haveKey) return;
        dec.decode(new EncodedVideoChunk({ type: r.key ? "key" : "delta", timestamp: (t0 += 33_333), data: r.frame })); }
      else if (pt === apt) { const pcm = core.recv(p); stats.audioPkts++; let s = 0; for (const x of pcm) s += x * x; stats.audioRms += Math.sqrt(s / pcm.length) / 32768; stats.rmsN++; }
    } catch { stats.srtpErr++; } };
  const start = performance.now(); await sleep(seconds * 1000); const end = performance.now();
  live = false; node.port.onmessage = null; encStop = true; reader?.cancel(); enc?.close(); dec?.close(); ms.getTracks().forEach((t) => t.stop()); await ctx.close(); ws.close(); core.close();
  await rpc(callId, userId, "plain:close");
  return { ...stats, rms: stats.rmsN ? stats.audioRms / stats.rmsN : 0, fps: stats.firstFrameAt ? stats.videoFrames / ((end - stats.firstFrameAt) / 1000) : 0, firstFrameMs: stats.firstFrameAt ? stats.firstFrameAt - start : null, consumers: consumers.map((c) => c.kind) };
};
window.olReady = true;
