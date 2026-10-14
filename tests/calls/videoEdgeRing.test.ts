// #49 last-frame hold, #50 edge-to-edge call video, full-length ring, symmetric non-covering call bar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { videoFit, MAX_COVER_ZOOM } from "../../src/lib/calls/frameHold";

const overlay = readFileSync("src/components/calls/CallOverlay.tsx", "utf8");
const css = readFileSync("src/components/calls/calls.module.css", "utf8");
const engine = readFileSync("src/lib/calls/engine.ts", "utf8");
const tones = readFileSync("src/lib/calls/tones.ts", "utf8");

test("#50 phones/tablets always cover edge to edge (375/412/820)", () => {
  for (const [sw, sh] of [[375, 812], [412, 915], [820, 1180]]) {
    for (const [vw, vh] of [[720, 1280], [1280, 720], [480, 640], [640, 480]]) assert.equal(videoFit(vw, vh, sw, sh), "cover", `${vw}x${vh} on ${sw}`);
  }
});
test("#50 desktop: cover unless that over-zooms a portrait phone feed", () => {
  assert.equal(videoFit(1280, 720, 1280, 800), "cover");
  assert.equal(videoFit(720, 1280, 1280, 800), "contain");
  assert.ok(MAX_COVER_ZOOM >= 2);
  assert.equal(videoFit(0, 0, 1280, 800), "cover");
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
