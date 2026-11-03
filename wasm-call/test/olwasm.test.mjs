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
