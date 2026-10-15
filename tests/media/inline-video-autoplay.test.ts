import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const bubble = readFileSync("src/components/media/MediaBubble.tsx", "utf8");
const inline = bubble.slice(bubble.indexOf("function InlineVideo"), bubble.indexOf("// ---------- documents ----------"));
const tile = bubble.slice(bubble.indexOf("function VisualTile"), bubble.indexOf("function InlineVideo"));

test("real videos (not just GIFs) get an inline muted autoplay source once ready", () => {
  assert.doesNotMatch(bubble, /const src = a\.gif \? urls\?\.full : undefined/);
  assert.doesNotMatch(inline, /if \(!a\.gif\)\s*return \(/);
  assert.match(bubble, /status === "processing"\) return undefined;\s*return urls\?\.full/);
});

test("inline video has every attribute Android WebView / iOS WKWebView need to autoplay inline", () => {
  for (const attr of [/\bmuted\b/, /playsInline/, /"webkit-playsinline": "true"/, /v\.muted = true/, /poster=\{BLANK_POSTER\}/]) assert.match(inline, attr);
});

test("no play badge anywhere: first frame shows while buffering", () => {
  assert.doesNotMatch(inline, /<Play /);
  assert.doesNotMatch(inline, /video-play/);
  assert.match(inline, /onLoadedData=\{\(\) => setFrame\(true\)\}/);
  assert.match(inline, /onPlaying=\{\(\) => setPlaying\(true\)\}/);
  assert.doesNotMatch(tile, /<Play /);
});

test("visibility observer is bound to an always-mounted wrapper, not the late-mounting <video>", () => {
  assert.match(inline, /useInView<HTMLSpanElement>/);
  assert.match(inline, /ref=\{vref\}/);
  assert.doesNotMatch(inline, /<video\s+ref=\{ref\}/);
});
