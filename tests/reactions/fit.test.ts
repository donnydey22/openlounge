import { test } from "node:test";
import assert from "node:assert/strict";
import { emojiPanelHeight } from "../../src/lib/emoji/fit";

test("emoji panel height fits the screen: landscape phones keep the thread, tall screens cap", () => {
  assert.equal(emojiPanelHeight(375), 158); // iPhone SE landscape: ~42 %, thread stays visible
  assert.equal(emojiPanelHeight(300), 150); // floor
  assert.equal(emojiPanelHeight(667), 280);
  assert.equal(emojiPanelHeight(844), 300); // phone cap
  assert.equal(emojiPanelHeight(1180), 360); // tablets get a little more
  for (const h of [320, 375, 390, 480, 568, 640, 667, 768, 800, 844, 915, 932, 1024, 1080, 1180, 1280, 1366]) {
    const p = emojiPanelHeight(h);
    assert.ok(h - p >= 160 || p === 150, `${h}: panel ${p} leaves ${h - p}px for header + composer + thread`);
  }
});
