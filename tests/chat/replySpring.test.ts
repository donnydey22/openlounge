import assert from "node:assert/strict";
import { test } from "node:test";
import { REPLY_MAX_OFFSET, REPLY_THRESHOLD, iconStyle, releaseVelocity, rubberBand, simulateRelease } from "../../src/lib/chat/replySpring";

test("bubble follows the pointer 1:1 to the threshold, then rubber-bands to a hard cap", () => {
  assert.equal(rubberBand(-20), 0);
  assert.equal(rubberBand(30), 30);
  assert.equal(rubberBand(REPLY_THRESHOLD), REPLY_THRESHOLD);
  const past = rubberBand(REPLY_THRESHOLD + 50);
  assert.ok(past > REPLY_THRESHOLD && past < REPLY_THRESHOLD + 20);
  assert.equal(rubberBand(1000), REPLY_MAX_OFFSET);
  for (let x = 0; x < 400; x += 5) assert.ok(rubberBand(x + 5) >= rubberBand(x), "monotonic");
});

test("reply icon reveals and scales with the drag and is full size once armed", () => {
  const a = iconStyle(0, false);
  const b = iconStyle(28, false);
  const c = iconStyle(REPLY_THRESHOLD, true);
  assert.equal(a.opacity, 0);
  assert.ok(b.opacity > 0.4 && b.opacity < 0.6 && b.scale > a.scale && b.scale < 1);
  assert.equal(c.opacity, 1);
  assert.equal(c.scale, 1);
});

test("release spring settles fast with no visible overshoot, even when flung home", () => {
  for (const [x, v] of [[REPLY_THRESHOLD, 0], [REPLY_MAX_OFFSET, 0], [REPLY_MAX_OFFSET, -1500], [30, -400]]) {
    const r = simulateRelease(x, v);
    assert.ok(r.settleMs <= 450, `settles in ${r.settleMs} ms from ${x}px @ ${v}px/s`);
    assert.ok(r.overshootPx <= 4, `overshoot ${r.overshootPx}px`);
  }
});

test("release velocity uses only the last 100 ms of samples", () => {
  assert.equal(releaseVelocity([{ t: 0, x: 0 }]), 0);
  assert.equal(releaseVelocity([{ t: 0, x: 0 }, { t: 500, x: 0 }, { t: 550, x: 50 }, { t: 600, x: 100 }]), 1000);
});
