// Best-call (3ae8ff34, Oct 17, build 45 / 666ae7f) UDP strengths on the browser WebRTC calling lane (Donny, Oct 24).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectedProtocol, anyOnTcp, udpProbeDelay } from "../../src/lib/calls/udpProbe";
import { CALL_AUDIO_CONSTRAINTS, MIC_AUDIO_ENCODING, OPUS_VOICE_CODEC_OPTIONS, VOICE_FLOOR_BPS, voiceLadderBps, shouldRestartIce } from "../../src/lib/calls/audioPolicy";
import { CALL_JITTER_BUFFER_TARGET_MS } from "../../src/lib/calls/audioParity";
import { ADAPT, LADDER } from "../../src/lib/calls/netAdapt";
import { MEDIASOUP_TURN_TTL_S, mediasoupTurnUrls } from "../../server/calls/index";

const URLS = ["turn:turn.openlounge.app:3478?transport=udp", "turn:turn.openlounge.app:3478?transport=tcp", "turns:turn.openlounge.app:443?transport=tcp"];

test("UDP first in every lane: SFU offers direct UDP only; relay fallback is TURN TCP then TURNS 443; <= 10 min logins", () => {
  assert.deepEqual(mediasoupTurnUrls([URLS[2], URLS[0], URLS[1]]), [URLS[1], URLS[2]]);
  assert.ok(MEDIASOUP_TURN_TTL_S <= 600 && MEDIASOUP_TURN_TTL_S > 0);
  const sfu = readFileSync("media-sfu/src/config.mjs", "utf8") + readFileSync("media-sfu/src/index.mjs", "utf8");
  assert.match(sfu, /enableUdp: !tcpOnly/);
  assert.match(sfu, /preferUdp: !tcpOnly/);
  // browser / Keiko lane: same server-issued list, iceTransportPolicy "all" so direct UDP host candidates win
  const ms = readFileSync("src/lib/calls/mediasoupSession.ts", "utf8");
  assert.match(ms, /iceServers: this\.media\.iceServers \?\? \[\], iceTransportPolicy: "all"/);
  // iPhone native lane: the page forwards the same list; the app opens transports with policy "all" unless relay-only
  const nat = readFileSync("src/lib/calls/nativeMediaSession.ts", "utf8");
  assert.match(nat, /op: "connect", callId, iceServers: m\.iceServers \?\? \[\]/);
});
test("Opus: FEC on, DTX off, mono, 48 kHz, 48 kbps cap, 20 ms ptime", () => {
  assert.equal(OPUS_VOICE_CODEC_OPTIONS.opusFec, true);
  assert.equal(OPUS_VOICE_CODEC_OPTIONS.opusDtx, false);
  assert.equal(OPUS_VOICE_CODEC_OPTIONS.opusStereo, false);
  assert.equal(OPUS_VOICE_CODEC_OPTIONS.opusMaxPlaybackRate, 48_000);
  assert.equal(OPUS_VOICE_CODEC_OPTIONS.opusMaxAverageBitrate, 48_000);
  assert.equal(OPUS_VOICE_CODEC_OPTIONS.opusPtime, 20);
});
test("audio encoding high priority + high network priority, independent of video", () => {
  assert.deepEqual(MIC_AUDIO_ENCODING, { maxBitrate: 48_000, priority: "high", networkPriority: "high" });
});
test("mic AEC/NS/AGC ideal (never exact), mono, 48 kHz; no jitter buffer override", () => {
  assert.deepEqual(CALL_AUDIO_CONSTRAINTS, { echoCancellation: { ideal: true }, noiseSuppression: { ideal: true }, autoGainControl: { ideal: true }, channelCount: { ideal: 1 }, sampleRate: { ideal: 48_000 } });
  assert.equal(CALL_JITTER_BUFFER_TARGET_MS, null);
});
test("ladder 48/32/24 with a 24 kbps floor on every platform; down after 2 bad s (>5% / >450 ms), up after 8 good s", () => {
  assert.equal(VOICE_FLOOR_BPS, 24_000);
  for (const ua of ["", "Android", "iPhone", "Macintosh"]) assert.deepEqual(LADDER.map((r) => voiceLadderBps(r.audioBps, ua)), [48_000, 32_000, 24_000, 24_000]);
  assert.equal(ADAPT.sampleMs, 1_000); assert.equal(ADAPT.downAfter, 2); assert.equal(ADAPT.upAfter, 8);
  assert.equal(ADAPT.lossPercent, 5); assert.equal(ADAPT.rttMs, 450);
});
test("b334724: ladder climbs back after a floor drop while the transport is still connected", () => {
  const e = readFileSync("src/lib/calls/engine.ts", "utf8");
  assert.match(e, /call 3ae8ff34: a short blip at the floor while the transport stayed connected/);
});
test("recovery: ICE restart on the same server before any fallback", () => {
  assert.equal(shouldRestartIce("disconnected"), true); assert.equal(shouldRestartIce("failed"), true); assert.equal(shouldRestartIce("connected"), false);
  const s = readFileSync("src/lib/calls/mediasoupSession.ts", "utf8");
  assert.match(s, /shouldRestartIce\(state\)[\s\S]{0,120}this\.restartIce\(transport, direction\)/);
  assert.match(s, /"ms:transport:restartIce"/);
});

// Continuous UDP (Donny, Oct 24 5:29 AM): UDP is held for the whole call, not just at setup.
const rep = (rows: object[]) => new Map(rows.map((r: any, i) => [r.id ?? String(i), r]));
const onUdp = rep([{ type: "transport", selectedCandidatePairId: "p" }, { id: "p", type: "candidate-pair", localCandidateId: "l" }, { id: "l", type: "local-candidate", protocol: "udp", candidateType: "host" }]);
const onRelay443 = rep([{ type: "transport", selectedCandidatePairId: "p" }, { id: "p", type: "candidate-pair", localCandidateId: "l" }, { id: "l", type: "local-candidate", protocol: "udp", candidateType: "relay", relayProtocol: "tls" }]);
test("stays on UDP across a transient drop: in-place ICE restart on the same SFU, same producers, no teardown", () => {
  const ms = readFileSync("src/lib/calls/mediasoupSession.ts", "utf8");
  const blk = ms.slice(ms.indexOf("First outage on this transport"), ms.indexOf('if (state === "failed" || state === "closed")', ms.indexOf("First outage on this transport")));
  assert.match(blk, /restart ICE in place \(same producers\/consumers, no renegotiation\)/);
  assert.match(blk, /void this\.restartIce\(transport, direction\)/);
  assert.doesNotMatch(blk, /close\(|createSendTransport|createRecvTransport/);
  assert.equal(selectedProtocol(onUdp as never), "udp");
});
test("returns from relay (TCP/443) to UDP when UDP recovers: probe = in-place ICE restart while on relay, never gives up", () => {
  assert.equal(anyOnTcp([onRelay443 as never]), true, "TURNS 443 relay counts as off-UDP so the probe keeps running");
  assert.equal(anyOnTcp([onUdp as never]), false, "back on UDP: probe stops");
  assert.ok(udpProbeDelay(0) <= 3_000, "first UDP retry within ~3 s");
  assert.ok(udpProbeDelay(100) > 0, "keeps probing until hang-up");
  const eng = readFileSync("src/lib/calls/engine.ts", "utf8");
  const p = eng.slice(eng.indexOf("private startUdpProbe("), eng.indexOf("// ---------- reconnect ----------"));
  assert.match(p, /restartIceAll\(\)/);
  assert.doesNotMatch(p, /dropMediaForRejoin|connectMediasoup|parkMediaForSwitch/, "migration keeps audio flowing (no teardown)");
});
test("voice keeps top priority for the whole call", () => {
  assert.equal(MIC_AUDIO_ENCODING.priority, "high");
  assert.equal(MIC_AUDIO_ENCODING.networkPriority, "high");
});
