import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const overlay = readFileSync("src/components/calls/CallOverlay.tsx", "utf8");
const engine = readFileSync("src/lib/calls/engine.ts", "utf8");
test("Speaker vs Phone: distinct icon + label per route, active state on speaker", () => {
  assert.match(overlay, /label=\{s\.speaker \? "Speaker" : "Phone"\} active=\{s\.speaker\}/);
  assert.match(overlay, /s\.speaker \? <Volume2[^>]*data-route="speaker" \/> : <Ear[^>]*data-route="phone" \/>/);
});
test("button follows the actual iOS route (not the last tap); headset routes ignored", () => {
  assert.match(engine, /addEventListener\("openlounge:native-audio-route"[\s\S]{0,200}d\.headset[\s\S]{0,120}this\.set\(\{ speaker: d\.speaker \}\)/);
});
