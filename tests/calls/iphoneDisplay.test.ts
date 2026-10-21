import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const styles = readFileSync(new URL("../../src/components/calls/calls.module.css", import.meta.url), "utf8");
const overlay = readFileSync(new URL("../../src/components/calls/CallOverlay.tsx", import.meta.url), "utf8");

test("native caller-video hidden web PiP paints neither its box shadow nor any descendant", () => {
  assert.match(styles, /\.nativeVideoScreen \.pip \{ box-shadow: none !important; visibility: hidden !important; \}/);
  assert.match(styles, /\.nativeVideoScreen \.pip \* \{ visibility: hidden !important; \}/);
  // visibility preserves the measurable box; the native caller's fixed PiP is intentionally not hit-testable.
  // display:none would change bridge geometry. Ordinary Android/web PiP interactions remain unchanged.
  const nativePip = styles.match(/\.nativeVideoScreen \.pip \{[^}]*\}/)?.[0] ?? "";
  assert.doesNotMatch(nativePip, /display:\s*none/);
  assert.match(overlay, /const nativeFullscreen = s\.nativeVideo && !s\.minimized/);
  assert.match(overlay, /nativeFullscreen && css\.nativeVideoScreen/);
});

test("ordinary Android/web/incoming PiP retains its existing style and media engine", () => {
  const basePip = styles.match(/^\.pip \{[^}]*\}/m)?.[0] ?? "";
  assert.match(basePip, /box-shadow: 0 10px 30px/);
  assert.match(basePip, /border-radius: 18px/);
  assert.match(overlay, /showPip && <Pip/);
  assert.match(overlay, /const \[swap, setSwap\] = useState\(false\)/);
});
