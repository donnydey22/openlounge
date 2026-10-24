// Video call start with OS camera/mic prompts (Donny + Keiko, Oct 23 2026 call 89a7c572).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ov = readFileSync("src/components/calls/CallOverlay.tsx", "utf8");
const fh = readFileSync("src/lib/calls/frameHold.ts", "utf8");
const ms = readFileSync("src/lib/calls/mediasoupSession.ts", "utf8");
const eng = readFileSync("src/lib/calls/engine.ts", "utf8");

test("permission prompt: curtain fallback only runs once the big tile has a feed attached", () => {
  assert.match(ov, /if \(!s\.nativeVideo && !stageFed && s\.remoteCam\) return;/);
  assert.match(ov, /addEventListener\("loadstart", onLoadStart\)/);
  assert.match(ov, /onAttached=\{onStageAttached\}/);
});

test("self-view → remote swap seeds the hold canvas (no black frame between feeds), bounded by SEED_MAX_MS", () => {
  assert.match(ov, /seedHold\(el, canvas\)/);
  assert.match(fh, /export function seedHold\(/);
  assert.match(fh, /const seeded = canvas\.dataset\.seed === "1";/);
  assert.match(fh, /SEED_MAX_MS/);
});

