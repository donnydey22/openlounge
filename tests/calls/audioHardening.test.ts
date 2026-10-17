import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MIC_AUDIO_ENCODING, OPUS_VOICE_CODEC_OPTIONS, micNeedsRecovery, resumePausedCallAudio, shouldRestartIce,
} from "../../src/lib/calls/audioPolicy";
import { AUDIO_SPEECH } from "../../src/lib/calls/videoPolicy";
import { MediasoupCallSession } from "../../src/lib/calls/mediasoupSession";

const media = { provider: "mediasoup", callId: "call1" } as any;

test("Opus voice: mono, DTX, inband FEC, 48 kbps average, 20 ms ptime", () => {
  assert.equal(OPUS_VOICE_CODEC_OPTIONS.opusStereo, false);
  assert.equal(OPUS_VOICE_CODEC_OPTIONS.opusDtx, true);
  assert.equal(OPUS_VOICE_CODEC_OPTIONS.opusFec, true);
  assert.ok(OPUS_VOICE_CODEC_OPTIONS.opusMaxAverageBitrate >= 32_000 && OPUS_VOICE_CODEC_OPTIONS.opusMaxAverageBitrate <= 48_000);
  assert.equal(OPUS_VOICE_CODEC_OPTIONS.opusPtime, 20);
});

test("voice encoding has high bandwidth + network priority and its own cap, not a video cap", () => {
  assert.equal(MIC_AUDIO_ENCODING.priority, "high");
  assert.equal(MIC_AUDIO_ENCODING.networkPriority, "high");
  assert.equal(MIC_AUDIO_ENCODING.maxBitrate, AUDIO_SPEECH.maxBitrate);
  assert.ok(MIC_AUDIO_ENCODING.maxBitrate < 150_000, "below even the lowest video layer");
});

test("mediasoup mic producer is published with the Opus options and the high-priority encoding", async () => {
  const produced: any[] = [];
  const s = new MediasoupCallSession({ on() {}, off() {}, request: async () => ({ ok: true }) } as any, media, { onRemoteTrack() {}, onState() {}, onLocalVideo() {} });
  const a = s as any;
  const track = { kind: "audio", readyState: "live", addEventListener() {}, removeEventListener() {}, stop() {} };
  (globalThis as any).navigator = { userAgent: "Android", mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track] }), addEventListener() {}, removeEventListener() {} } };
  a.send = { close() {}, produce: async (o: any) => { produced.push(o); return { close() {}, pause() {}, resume() {}, replaceTrack: async () => {} }; } };
  await a.publishAudio();
  assert.equal(produced.length, 1);
  assert.deepEqual(produced[0].codecOptions, OPUS_VOICE_CODEC_OPTIONS);
  assert.deepEqual(produced[0].encodings, [{ ...MIC_AUDIO_ENCODING }]);
  s.close();
});

test("ICE restart triggers only on disconnected/failed", () => {
  assert.equal(shouldRestartIce("disconnected"), true);
  assert.equal(shouldRestartIce("failed"), true);
  for (const st of ["new", "connecting", "connected", "closed"]) assert.equal(shouldRestartIce(st), false);
});

test("first outage restarts ICE in place and reports disconnected; second failure falls through to failed (TCP fallback)", async () => {
  const requests: any[] = [];
  const states: string[] = [];
  const restarted: any[] = [];
  const s = new MediasoupCallSession({ on() {}, off() {}, request: async (ev: string, d: any) => {
    requests.push([ev, d]);
    return ev === "ms:transport:restartIce" ? { ok: true, iceParameters: { usernameFragment: "u", password: "p" } } : { ok: true };
  } } as any, media, { onRemoteTrack() {}, onState: (x) => states.push(x), onLocalVideo() {} });
  const a = s as any;
  const handlers = new Map<string, (x: any) => void>();
  const transport = { id: "t1", on: (ev: string, fn: any) => handlers.set(ev, fn), restartIce: async (p: any) => restarted.push(p) };
  a.wireTransport(transport, "recv");
  a.connected = true;
  handlers.get("connectionstatechange")!("failed");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(states, ["disconnected"]);
  assert.deepEqual(requests[0], ["ms:transport:restartIce", { callId: "call1", direction: "recv", transportId: "t1" }]);
  assert.deepEqual(restarted, [{ iceParameters: { usernameFragment: "u", password: "p" } }]);
  handlers.get("connectionstatechange")!("failed");
  assert.deepEqual(states, ["disconnected", "failed"]);
  // a successful recovery clears the episode and reports connected
  handlers.get("connectionstatechange")!("connected");
  assert.equal(states.at(-1), "connected");
  assert.equal(a.iceRestarted.size, 0);
});

test("ICE restart errors are swallowed so the engine's TCP fallback timer still runs", async () => {
  const s = new MediasoupCallSession({ on() {}, off() {}, request: async () => { throw new Error("old sfu"); } } as any, media, { onRemoteTrack() {}, onState() {}, onLocalVideo() {} });
  await (s as any).restartIce({ id: "t", restartIce: async () => { throw new Error("x"); } }, "send");
});

test("server relays and validates ms:transport:restartIce; SFU implements it", () => {
  assert.match(readFileSync("server/calls/index.ts", "utf8"), /ms:transport:restartIce", relay\("transport:restartIce"\)/);
  assert.match(readFileSync("server/wsSchemas.ts", "utf8"), /"ms:transport:restartIce": \{ callId: "id", direction: "string", transportId: "id" \}/);
  assert.match(readFileSync("media-sfu/src/index.mjs", "utf8"), /method === "transport:restartIce"[\s\S]*transport\.restartIce\(\)/);
});

test("mic recovery decision: ended track or vanished device; default/communications ids never false-trigger", () => {
  assert.equal(micNeedsRecovery(null), false);
  assert.equal(micNeedsRecovery({ readyState: "ended" }), true);
  const t = (id: string) => ({ readyState: "live" as const, getSettings: () => ({ deviceId: id }) });
  assert.equal(micNeedsRecovery(t("usb"), ["builtin"]), true);
  assert.equal(micNeedsRecovery(t("usb"), ["usb", "builtin"]), false);
  assert.equal(micNeedsRecovery(t("default"), ["builtin"]), false);
  assert.equal(micNeedsRecovery(t("usb"), []), false);
});

test("ended microphone is recaptured and swapped into the same producer without renegotiation", async () => {
  const replaced: any[] = [];
  let stopped = 0;
  const next = { id: "new", addEventListener() {}, removeEventListener() {}, stop() {} };
  (globalThis as any).navigator = { mediaDevices: { getUserMedia: async (c: any) => { assert.ok(c.audio.echoCancellation); return { getAudioTracks: () => [next] }; }, removeEventListener() {} } };
  const s = new MediasoupCallSession({ on() {}, off() {}, request: async () => ({ ok: true }) } as any, media, { onRemoteTrack() {}, onState() {}, onLocalVideo() {} });
  const a = s as any;
  a.mic = { id: "old", readyState: "ended", removeEventListener() {}, stop: () => stopped++ };
  a.producers.set("audio", { close() {}, pause() {}, resume() {}, replaceTrack: async (x: any) => replaced.push(x.track.id) });
  await Promise.all([s.recoverMic(), s.recoverMic()]); // concurrent triggers coalesce
  assert.deepEqual(replaced, ["new"]);
  assert.equal(stopped, 1);
  assert.equal(a.mic, next);
  assert.equal(a.micOutbound, next);
});

test("mic recovery keeps the old track if recapture fails", async () => {
  (globalThis as any).navigator = { mediaDevices: { getUserMedia: async () => { throw new Error("denied"); } } };
  const s = new MediasoupCallSession({ on() {}, off() {}, request: async () => ({ ok: true }) } as any, media, { onRemoteTrack() {}, onState() {}, onLocalVideo() {} });
  const a = s as any;
  const old = { readyState: "ended", stop() { throw new Error("must not stop"); } };
  a.mic = old;
  a.producers.set("audio", { close() {}, pause() {}, resume() {}, replaceTrack: async () => assert.fail("no replace") });
  await s.recoverMic();
  assert.equal(a.mic, old);
});

test("paused remote voice elements are replayed; a still-blocked element is reported", async () => {
  let played = 0;
  const ok = { paused: true, play: async () => { played++; } };
  const playing = { paused: false, play: async () => assert.fail("already playing") };
  assert.equal(await resumePausedCallAudio([ok, playing] as any), false);
  assert.equal(played, 1);
  const blocked = { paused: true, play: async () => { throw new Error("NotAllowedError"); } };
  assert.equal(await resumePausedCallAudio([blocked] as any), true);
});

test("engine: one audio element per remote track and foreground resume wiring", () => {
  const src = readFileSync("src/lib/calls/engine.ts", "utf8");
  assert.match(src, /audioEls\.some\(\(x\) => \(x\.srcObject as MediaStream \| null\)\?\.getAudioTracks\?\.\(\)\.some\(\(t\) => t\.id === track\.id\)\)\) return;/);
  assert.match(src, /addEventListener\("visibilitychange", this\.onVisibleCallAudio\)/);
  assert.match(src, /removeEventListener\("visibilitychange", this\.onVisibleCallAudio\)/);
});
