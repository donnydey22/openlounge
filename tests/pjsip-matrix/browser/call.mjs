// Browser leg for the matrix: getUserMedia (capture only) -> AudioWorklet PCM / MediaStreamTrackProcessor frames ->
// WASM Opus / WASM H.264 (openh264) encode, single layer, 720p cap (PLAN §14) -> WASM RTP+SRTP -> WS relay -> mediasoup PlainTransport -> back the same way.
// No RTCPeerConnection anywhere. window.olCall(opts) resolves with measured receive stats.
import factory from "/wasm-call/dist/olwasm.mjs";
import { MediaCore, newKeyB64, isKeyRequest } from "/wasm-call/src/client.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (callId, userId, method, payload = {}) => { const r = await fetch("/rpc", { method: "POST", body: JSON.stringify({ callId, userId, method, payload }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j; };

window.olSignal = (userId) => new Promise((ok) => { const ws = new WebSocket(`${location.origin.replace("http", "ws")}/signal?token=${userId}`);
  const box = { ws, msgs: [], wait: async (t) => { for (let i = 0; i < 300; i++) { const m = box.msgs.find((x) => x.t === t); if (m) { box.msgs.splice(box.msgs.indexOf(m), 1); return m; } await sleep(100); } throw new Error(`no ${t}`); },
    send: (m) => ws.send(JSON.stringify(m)) };
  ws.onmessage = (e) => box.msgs.push(JSON.parse(e.data)); ws.onopen = () => { window.__sig = box; ok(true); }; });

function rgbaToI420(d, w, h) { const o = new Uint8Array(w * h * 3 / 2), U = w * h, V = U + U / 4;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; o[y * w + x] = (66 * d[i] + 129 * d[i + 1] + 25 * d[i + 2] + 4224) >> 8;
    if (!(x & 1) && !(y & 1)) { const c = (y >> 1) * (w >> 1) + (x >> 1); o[U + c] = (-38 * d[i] - 74 * d[i + 1] + 112 * d[i + 2] + 32896) >> 8; o[V + c] = (112 * d[i] - 94 * d[i + 1] - 18 * d[i + 2] + 32896) >> 8; } }
  return o; }
window.olStop = () => { window.__olStop = true; };
window.olCall = async ({ callId, userId, relayUrl, video, seconds = 30, headlessPacing = false }) => {
  window.__olStop = false;
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
  const ms = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: video ? { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: 30 } : false });
  const ctx = new AudioContext({ sampleRate: 48000 }); await ctx.audioWorklet.addModule("/wasm-call/src/pcm-worklet.js");
  const node = new AudioWorkletNode(ctx, "ol-pcm"); ctx.createMediaStreamSource(ms).connect(node); node.connect(ctx.destination);
  let live = true; node.port.onmessage = (e) => { if (live && !headlessPacing) send(core.send(e.data)); };
  // CI-only "headless pacing": macOS runners have no audio hardware, so the AudioWorklet render clock runs slow and starves
  // sends. Feed synthesized 440 Hz 20 ms frames on a drift-corrected 20 ms timer into the SAME core.send (WASM Opus/RTP/SRTP).
  let paceTimer = null;
  if (headlessPacing) { let ph = 0, n = 0; const t0 = performance.now();
    const tick = () => { if (!live) return; const due = Math.floor((performance.now() - t0) / 20) + 1;
      while (n < due) { const f = new Int16Array(960); for (let k = 0; k < 960; k++) { f[k] = Math.round(Math.sin(ph) * 16000); ph += 2 * Math.PI * 440 / 48000; } send(core.send(f)); n++; }
      paceTimer = setTimeout(tick, Math.max(0, t0 + n * 20 - performance.now())); };
    tick(); stats.headlessPacing = true; }
  await rpc(callId, userId, "plain:produce", { kind: "audio", ssrc: assrc, payloadType: 111 });
  let enc, reader, encLoop, encStop = false, keyReq = false;
  if (video) {
    await rpc(callId, userId, "plain:produce", { kind: "video", ssrc: vssrc, payloadType: 102 });
    // WASM H.264 encode (no WebCodecs/WebRTC encode): VideoFrame -> I420 -> openh264 in WASM -> RTP/SRTP in WASM
    let n = 0, cv = null, g2 = null; const maxW = headlessPacing ? 640 : 1280, maxH = headlessPacing ? 360 : 720; /* macOS CI: WASM 720p encode starves next to the simulator */ reader = new MediaStreamTrackProcessor({ track: ms.getVideoTracks()[0] }).readable.getReader();
    encLoop = (async () => { while (!encStop) { const { value: fr, done } = await reader.read(); if (done) break;
      try { const w = Math.min(maxW, fr.displayWidth) & ~1, h = Math.min(maxH, fr.displayHeight) & ~1;
        if (!enc) { enc = core.videoEncoder({ width: w, height: h, bitrate: 800_000, fps: 30, keyIntervalFrames: 60 }); stats.encW = w; stats.encH = h; stats.encoder = "wasm-openh264"; }
        let i420;
        if (fr.format === "I420" && fr.codedWidth === w && fr.codedHeight === h) { i420 = new Uint8Array(w * h * 3 / 2); await fr.copyTo(i420); }
        else { if (!cv) { cv = new OffscreenCanvas(w, h); g2 = cv.getContext("2d", { willReadFrequently: true }); } g2.drawImage(fr, 0, 0, w, h); i420 = rgbaToI420(g2.getImageData(0, 0, w, h).data, w, h); }
        const r = enc.encode(i420, Math.round(fr.timestamp / 1000), n++ === 0 || keyReq); if (keyReq) { keyReq = false; stats.keyReqServed = (stats.keyReqServed || 0) + 1; };
        if (r) { stats.encFrames = (stats.encFrames || 0) + 1; if (r.key) stats.encKeys = (stats.encKeys || 0) + 1; for (const p of core.videoSend(r.au, Math.round(fr.timestamp * 0.09))) send(p); }
      } catch (e) { stats.encErr = String(e.message || e); } finally { fr.close(); } } enc?.close(); enc = null; })();
  }
  // consume the peer (poll until its producers exist)
  let consumers = [];
  for (let i = 0; i < 100 && consumers.length < (video ? 2 : 1); i++) { consumers = consumers.concat((await rpc(callId, userId, "plain:consume")).consumers); await sleep(200); }
  const vpt = consumers.find((c) => c.kind === "video")?.payloadType, apt = consumers.find((c) => c.kind === "audio")?.payloadType;
  const canvas = new OffscreenCanvas(64, 48); const g = canvas.getContext("2d", { willReadFrequently: true });
  const dec = video ? new VideoDecoder({ output: (f) => { if (!stats.firstFrameAt) stats.firstFrameAt = performance.now(); stats.videoFrames++; if (stats.videoFrames % 10 === 0) { g.drawImage(f, 0, 0, 64, 48); const d = g.getImageData(0, 0, 64, 48).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; if (s / (d.length / 4) / 3 > 16) stats.nonBlack++; } f.close(); }, error: () => stats.decodeErr++ }) : null;
  dec?.configure({ codec: "avc1.42001f", optimizeForLatency: true });
  let haveKey = false, t0 = 0;
  ws.onmessage = (e) => { const p = new Uint8Array(e.data); if (p[1] >= 192 && p[1] <= 223) { if (isKeyRequest(p)) { keyReq = true; stats.pliRx = (stats.pliRx || 0) + 1; } return; } /* RTCP: PLI/FIR -> IDR on next frame */ const pt = p[1] & 0x7f;
    try {
      if (video && pt === vpt) { if (!stats.firstVideoPktAt) stats.firstVideoPktAt = performance.now(); const r = core.videoRecv(p); if (!r) return; if (r.lost) { haveKey = false; return; } if (r.key) { haveKey = true; stats.videoKey++; } if (!haveKey) return;
        dec.decode(new EncodedVideoChunk({ type: r.key ? "key" : "delta", timestamp: (t0 += 33_333), data: r.frame })); }
      else if (pt === apt) { const pcm = core.recv(p); stats.audioPkts++; let s = 0; for (const x of pcm) s += x * x; stats.audioRms += Math.sqrt(s / pcm.length) / 32768; stats.rmsN++; }
    } catch { stats.srtpErr++; } };
  const start = performance.now(), until = start + seconds * 1000; // runs until olStop() or the cap (phone launch time varies)
  while (!window.__olStop && performance.now() < until) await sleep(100); const end = performance.now();
  live = false; node.port.onmessage = null; encStop = true; reader?.cancel().catch(() => {}); await encLoop; dec?.close(); ms.getTracks().forEach((t) => t.stop()); await ctx.close(); ws.close(); core.close();
  await rpc(callId, userId, "plain:close");
  return { ...stats, rms: stats.rmsN ? stats.audioRms / stats.rmsN : 0, fps: stats.firstFrameAt ? stats.videoFrames / ((end - stats.firstFrameAt) / 1000) : 0, firstFrameMs: stats.firstFrameAt && stats.firstVideoPktAt ? stats.firstFrameAt - stats.firstVideoPktAt : null, callToFirstFrameMs: stats.firstFrameAt ? stats.firstFrameAt - start : null, firstVideoPktMs: stats.firstVideoPktAt ? stats.firstVideoPktAt - start : null, consumers: consumers.map((c) => c.kind) };
};
window.olReady = true;
