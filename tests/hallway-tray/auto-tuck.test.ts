import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mini = readFileSync("src/components/room/LiveRoomProvider.tsx", "utf8");
const css = readFileSync("src/app/globals.css", "utf8");

test("tray auto-tucks after an idle timeout of ~5s", () => {
  assert.match(mini, /export const TRAY_IDLE_MS = 5000/);
  assert.match(mini, /setTimeout\(\(\) => setTucked\(true\), TRAY_IDLE_MS\)/);
});

test("never tucks while reaction tray open, audio not connected, or audio needs a tap", () => {
  assert.match(mini, /holdOpen = reactionTrayOpen \|\| audio\.status !== "connected" \|\| !!audio\.needsGesture/);
  assert.match(mini, /if \(tucked \|\| holdOpen\) return;/);
});

test("any interaction resets the idle timer; tab tap reopens", () => {
  assert.match(mini, /onPointerDown=\{interact\}/);
  assert.match(mini, /onKeyDown=\{interact\}/);
  assert.match(mini, /data-testid="live-room-tab"/);
  assert.match(mini, /setTucked\(false\); interact\(\);/);
});

test("tucked tab lives inside the measured bar, so space stays reserved (never covers UI)", () => {
  const barStart = mini.indexOf("ref={barRef}");
  const tab = mini.indexOf('data-testid="live-room-tab"');
  assert.ok(barStart > 0 && tab > barStart);
  assert.match(mini, /\[visible, reactionTrayOpen, tucked\]/);
  assert.match(css, /ol-tray-tab/);
  assert.match(css, /prefers-reduced-motion/);
});
