// #49 last-frame hold, #50 edge-to-edge call video, full-length ring, symmetric non-covering call bar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { videoFit } from "../../src/lib/calls/frameHold";

const overlay = readFileSync("src/components/calls/CallOverlay.tsx", "utf8");
const css = readFileSync("src/components/calls/calls.module.css", "utf8");
const engine = readFileSync("src/lib/calls/engine.ts", "utf8");
const tones = readFileSync("src/lib/calls/tones.ts", "utf8");

test("phones (portrait + landscape) cover edge to edge", () => {
  for (const [sw, sh] of [[375, 667], [375, 812], [412, 915], [667, 375], [812, 375], [915, 412]]) {
    for (const [vw, vh] of [[720, 1280], [1280, 720], [480, 640], [640, 480]]) assert.equal(videoFit(vw, vh, sw, sh), "cover", `${vw}x${vh} on ${sw}x${sh}`);
  }
});
test("tablets/desktop show the whole picture (contain)", () => {
  for (const [sw, sh] of [[820, 1180], [1180, 820], [1280, 800], [1920, 1080]]) assert.equal(videoFit(720, 1280, sw, sh, sw === 820 || sw === 1180), "contain");
  assert.equal(videoFit(720, 1280, 1280, 500, false), "contain");
});
test("stage = viewport; contain + blurred backdrop, cover on phones", () => {
  assert.match(css, /\.videoStage[\s\S]*position: fixed[\s\S]*100dvh/);
  assert.match(css, /\.stageVideo[\s\S]*object-fit: contain/);
  assert.match(css, /\.stageBackdrop[\s\S]*blur\(30px\)[\s\S]*pointer-events: none/);
  assert.match(css, /@media \(max-width: 600px\), \(pointer: coarse\) and \(max-height: 600px\)[\s\S]*object-fit: cover[\s\S]*display: none/);
  assert.match(overlay, /mirrorBackdrop\(el, back\.current\)/);
});
test("#50 no blurred / gradient filler video behind the call picture", () => {
  assert.doesNotMatch(overlay, /-fill`|ref=\{fill\}|blur-3xl|blur-xl" style/);
  assert.match(css, /\.videoStage[\s\S]*100dvh/);
  assert.match(css, /\.stageVideo[\s\S]*object-fit: cover/);
});
test("#49 no poster / placeholder of any kind; last frame held on a canvas, no transition", () => {
  assert.doesNotMatch(overlay, /poster=/);
  assert.match(overlay, /holdFrames\(el, hold\.current\)/);
  assert.match(css, /\.holdFrame[^}]*transition: none/);
  assert.match(overlay, /controls=\{false\}/);
});
test("#49 engine swaps the track inside the same MediaStream (never clears srcObject mid-call)", () => {
  const raw = engine.slice(engine.indexOf("private attachRawVideo"), engine.indexOf("private onMediasoupState"));
  assert.doesNotMatch(raw, /srcObject\s*=/);
  assert.match(raw, /swapVideoTrack\(el, track\)/);
});
test("ring: deadline uses the server ring window, not the skewed device clock", async () => {
  const { ringUntil } = await import("../../src/lib/calls/engine");
  const now = 1_000_000;
  // server clock 40 s behind the phone: old code rang for the 3 s floor; now the full 45 s + grace
  const call = { createdAt: now - 40_000, expiresAt: now - 40_000 + 45_000 };
  assert.equal(ringUntil(call, now) - now, 47_000);
  assert.equal(ringUntil({ createdAt: 0, expiresAt: 0 }, now) - now, 47_000);
  assert.doesNotMatch(engine, /untilMs: \w+(\.\w+)*\.expiresAt \+ 2000/);
});
test("ring: fallback watchdog runs for the whole ring and is cleared on stop", () => {
  assert.match(tones, /watchTimer = setInterval\(fallback, 1000\)/);
  assert.match(tones, /clearInterval\(watchTimer\)/);
});
test("call bar: symmetric insets and pushes content instead of covering it", () => {
  assert.match(css, /padding-inline: max\(16px, env\(safe-area-inset-left, 0px\), env\(safe-area-inset-right, 0px\)\)/);
  assert.match(css, /html\[data-call-bar\]\) :global\(body\) \{ padding-top: var\(--ol-callbar-h\)/);
});
