// Runs the real WASM build in Node: tone -> Opus -> RTP -> SRTP -> ws-media-relay -> UDP "SFU" echo -> back -> decode.
import test from "node:test"; import assert from "node:assert/strict";
import dgram from "node:dgram"; import WebSocket from "ws";
import factory from "../dist/olwasm.mjs";
import { MediaCore, newKeyB64, audioOfferSdp, parseCrypto } from "../src/client.mjs";
import { createRelay } from "../../ws-media-relay/src/relay.mjs";
const tone = (i) => Int16Array.from({ length: 960 }, (_, k) => Math.round(8000 * Math.sin((2 * Math.PI * 440 * (i * 960 + k)) / 48000)));
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length) / 32768;

test("a=crypto round-trips in SDP", () => { const k = newKeyB64(); assert.equal(parseCrypto(audioOfferSdp({ keyB64: k, ssrc: 1 })), k); });
test("SRTP: right key decodes audio, wrong key rejected, loss -> PLC", async () => {
  const kA = newKeyB64(), kB = newKeyB64();
  const a = (await MediaCore.load(factory)).open({ txKeyB64: kA, rxKeyB64: kB, ssrc: 1111 });
  const b = (await MediaCore.load(factory)).open({ txKeyB64: kB, rxKeyB64: kA, ssrc: 2222 });
  const bad = (await MediaCore.load(factory)).open({ txKeyB64: kB, rxKeyB64: newKeyB64(), ssrc: 3333 });
  let last; for (let i = 0; i < 50; i++) { const p = a.send(tone(i)); assert.ok(p.length > 22); last = b.recv(p); }
  assert.ok(rms(last) > 0.05, `rms ${rms(last)}`);
  assert.throws(() => bad.recv(a.send(tone(51))), /recv -100/);
  assert.equal(b.recv(null).length, 960);
});
test("browser leg over WS relay to a UDP SFU tuple and back", async () => {
  const sfu = dgram.createSocket("udp4"); await new Promise((r) => sfu.bind(0, "127.0.0.1", r));
  sfu.on("message", (m, ri) => sfu.send(m, ri.port, ri.address)); // echo = loopback SFU leg
  const wss = createRelay({ port: 0, verify: () => "u", resolveTarget: () => ({ host: "127.0.0.1", port: sfu.address().port }) });
  await new Promise((r) => wss.on("listening", r));
  const k = newKeyB64(); const tx = (await MediaCore.load(factory)).open({ txKeyB64: k, rxKeyB64: k, ssrc: 5 });
  const ws = new WebSocket(`ws://127.0.0.1:${wss.address().port}/?token=t&callId=c`); await new Promise((r) => ws.on("open", r));
  const heard = []; ws.on("message", (d) => heard.push(tx.recv(new Uint8Array(d))));
  for (let i = 0; i < 50; i++) { ws.send(tx.send(tone(i))); await new Promise((r) => setTimeout(r, 2)); }
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(heard.length >= 45, `got ${heard.length}`); assert.ok(rms(heard.at(-1)) > 0.05);
  ws.close(); sfu.close(); wss.close();
});
test("H.264 RTP in WASM: FU-A packetize -> SRTP -> depacketize, IDR flagged, wrong key rejected", async () => {
  const k = newKeyB64(); const a = (await MediaCore.load(factory)).open({ txKeyB64: k, rxKeyB64: k, ssrc: 9 }).openVideo({ ssrc: 10 });
  const b = (await MediaCore.load(factory)).open({ txKeyB64: k, rxKeyB64: k, ssrc: 11 }).openVideo({ ssrc: 12 });
  const nal = (t, n) => [0, 0, 0, 1, t, ...Array.from({ length: n }, (_, i) => (i * 13 + 1) & 0xff | 1)];
  const au = Uint8Array.from([...nal(0x67, 10), ...nal(0x68, 4), ...nal(0x65, 9000)]);
  const pkts = a.videoSend(au, 90000); assert.ok(pkts.length >= 8);
  let r; for (const p of pkts) r = b.videoRecv(p) ?? r;
  assert.equal(r.key, true); assert.deepEqual(r.frame, au);
  const c = (await MediaCore.load(factory)).open({ txKeyB64: k, rxKeyB64: newKeyB64(), ssrc: 13 }).openVideo({ ssrc: 14 });
  assert.throws(() => c.videoRecv(a.videoSend(au, 93000)[0]), /vrecv -100/);
});
test("WASM H.264 encode (openh264): 720p single layer -> RTP/SRTP -> reassembled AUs, IDR every 2 s; >720p rejected", async () => {
  const k = newKeyB64(); const a = (await MediaCore.load(factory)).open({ txKeyB64: k, rxKeyB64: k, ssrc: 9 }).openVideo({ ssrc: 99, pt: 102 });
  assert.throws(() => a.videoEncoder({ width: 1920, height: 1080 }), /venc init/);
  const W = 1280, H = 720, enc = a.videoEncoder({ width: W, height: H, bitrate: 800_000, fps: 30, keyIntervalFrames: 60 });
  const f = new Uint8Array(W * H * 3 / 2); let aus = 0, keys = 0, got = 0, gotKey = 0, bytes = 0;
  for (let i = 0; i < 90; i++) { for (let y = 0; y < H; y++) f.fill((y + i * 4) & 255, y * W, y * W + W); f.fill(128, W * H);
    const r = enc.encode(f, i * 33, i === 0); if (!r) continue; aus++; if (r.key) keys++; bytes += r.au.length;
    for (const p of a.videoSend(r.au, i * 3000)) { const x = a.videoRecv(p); if (x && !x.lost) { got++; if (x.key) gotKey++; } } }
  enc.close();
  assert.ok(aus >= 85, `aus ${aus}`); assert.ok(keys >= 2 && keys <= 3, `keys ${keys}`); assert.equal(got, aus); assert.equal(gotKey, keys);
  assert.ok(bytes * 8 / 3 < 800_000 * 2.5, `bitrate ${bytes * 8 / 3}`);
});
