// Oct 16 2026 (Donny/Keiko calls): louder voice + UDP held longer / returned sooner, and an SFU watchdog that no
// longer SIGABRTs live calls when only the Railway gateway socket blips.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { UDP_PROBE_DELAYS_MS, udpProbeDelay } from "../../src/lib/calls/udpProbe";
import { UDP_RECOVERY_DEFAULTS } from "../../src/lib/calls/udpRecovery";
import { OPUS_VOICE_CODEC_OPTIONS } from "../../src/lib/calls/audioPolicy";
import { CALL_MIC_GAIN, CALL_MIC_COMPRESSOR } from "../../src/lib/calls/voiceProcessing";

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

test("UDP probe from TCP: first within 2 s, steady state every ≤15 s, never gives up", () => {
  assert.equal(UDP_PROBE_DELAYS_MS[0], 2_000);
  assert.ok(Math.max(...UDP_PROBE_DELAYS_MS) <= 15_000);
  assert.equal(udpProbeDelay(999), 15_000);
  assert.match(src("src/lib/calls/engine.ts"), /attempt === 0 \? 1_000 : udpProbeDelay/);
});

test("slower demotion: a UDP 'disconnected' blip gets 12 s before the TCP path is requested", () => {
  const e = src("src/lib/calls/engine.ts");
  assert.match(e, /static MS_TCP_DEMOTE_MS = 12_000/);
  assert.match(e, /setTimeout\(\(\) => void this\.requestTcpFallback\(\), CallEngine\.MS_TCP_DEMOTE_MS\)/);
});

test("faster return from the TCP bridge, still anti-flap capped", () => {
  assert.ok(UDP_RECOVERY_DEFAULTS.tcpStableMs <= 8_000);
  assert.ok(UDP_RECOVERY_DEFAULTS.baseBackoffMs <= 5_000);
  assert.ok(UDP_RECOVERY_DEFAULTS.maxBackoffMs <= 60_000);
});

test("SFU keeps the UDP pair through 30 s of missing consent and still prefers UDP", () => {
  const s = src("media-sfu/src/index.mjs");
  assert.match(s, /iceConsentTimeout: 30/);
  assert.match(s, /preferUdp: !tcpOnly/);
});

test("SFU watchdog liveness = worker alive; gateway outage never kills live calls", () => {
  const w = src("media-sfu/deploy/run-with-watchdog.sh");
  assert.doesNotMatch(w, /\[\[ \$body == \*'"gateway":true'\*/);
  assert.match(w, /\[\[ \$body == \*'"worker":true'\* \]\]/);
});

test("loudness: no DTX onset clipping, +6 dB desktop mic boost behind a safety compressor, full receive gain", () => {
  assert.equal(OPUS_VOICE_CODEC_OPTIONS.opusDtx, false);
  assert.equal(OPUS_VOICE_CODEC_OPTIONS.opusFec, true);
  assert.equal(CALL_MIC_GAIN, 2.0);
  assert.ok(CALL_MIC_COMPRESSOR.ratio >= 4 && CALL_MIC_COMPRESSOR.threshold <= -20);
  assert.match(src("src/lib/calls/engine.ts"), /el\.volume = 1;[^\n]*\n\s*el\.muted = false;/);
});
