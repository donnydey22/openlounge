import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { AXIS_LOCK_PX, REPLY_THRESHOLD, lockAxis, replyCompletes } from "../../src/lib/chat/replySpring";

test("FX-083 swipe reply: small dead zone, WhatsApp threshold", () => {
  assert.ok(AXIS_LOCK_PX >= 6 && AXIS_LOCK_PX <= 10);
  assert.ok(REPLY_THRESHOLD >= 48 && REPLY_THRESHOLD <= 64);
  assert.equal(lockAxis(5, 3), null, "inside the dead zone nothing locks (taps / long-press stay native)");
});

test("FX-083 swipe reply: direction lock favors a light, arcing horizontal swipe but keeps vertical scroll", () => {
  assert.equal(lockAxis(12, 0), "x");
  assert.equal(lockAxis(10, 11), "x", "a light swipe with a slight arc still swipes");
  assert.equal(lockAxis(4, 14), "y", "vertical drag scrolls");
  assert.equal(lockAxis(3, -20), "y", "vertical up scrolls");
  assert.equal(lockAxis(-14, 2), "y", "leftward drag never swipes to reply");
});

test("FX-083 swipe reply: a quick light flick replies, a slow short drag does not", () => {
  assert.ok(replyCompletes(REPLY_THRESHOLD, 0));
  assert.ok(replyCompletes(36, 900), "fast flick");
  assert.ok(!replyCompletes(36, 100), "slow short drag");
  assert.ok(!replyCompletes(20, 3000), "tiny flick");
});

test("FX-083 swipe reply: non-passive touchmove claims the horizontal swipe so the WebView can't cancel it", () => {
  const src = readFileSync("src/components/chat/ReplyGesture.tsx", "utf8");
  assert.match(src, /addEventListener\("touchmove", onMove, \{ passive: false \}\)/);
  assert.match(src, /e\.preventDefault\(\)/);
  assert.match(src, /touchAction: "pan-y"/, "vertical scroll still native");
  assert.doesNotMatch(src, /\.force\b|pressure/, "no pressure dependency");
});
