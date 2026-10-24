// FX-046 / FX-047: WhatsApp-style composer cap + jump-to-latest (pure maths + source guards).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMPOSER_MAX_LINES, badgeText, composerMaxHeight, distanceFromBottom, jumpPlan, showJumpButton } from "../../src/lib/chatScroll";

test("composer max height: ~6 lines on tall screens", () => {
  assert.equal(COMPOSER_MAX_LINES, 6);
  assert.equal(composerMaxHeight(22, 22, 900), 22 * 6 + 22);
});
test("composer max height: 40% of a short / keyboard-shrunk viewport", () => {
  assert.equal(composerMaxHeight(22, 22, 300), 120); // iPhone SE with keyboard up
  assert.ok(composerMaxHeight(22, 22, 100) >= 22 * 2 + 22, "never below 2 lines");
});
test("jump button: hidden near bottom, shown > one screen up, shown with unseen", () => {
  assert.equal(showJumpButton(0, 600, 0), false);
  assert.equal(showJumpButton(50, 600, 3), false);
  assert.equal(showJumpButton(400, 600, 0), false);
  assert.equal(showJumpButton(700, 600, 0), true);
  assert.equal(showJumpButton(200, 600, 2), true);
});
test("jump plan: instant pre-jump when very far, smooth glide otherwise", () => {
  assert.equal(jumpPlan(1000, 600).preJumpTo, null);
  assert.equal(jumpPlan(50_000, 600).preJumpTo, "near");
  assert.equal(distanceFromBottom({ scrollHeight: 2000, scrollTop: 400, clientHeight: 600 }), 1000);
});
test("badge text caps at 99+", () => {
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(7), "7");
  assert.equal(badgeText(150), "99+");
});
test("composer source: no unbounded growth, internal scroll, keyboard re-fit", () => {
  const src = readFileSync("src/components/chat/ChatComposer.tsx", "utf8");
  assert.ok(src.includes("composerMaxHeight("), "cap computed via composerMaxHeight");
  assert.ok(/visualViewport/.test(src), "re-fits on visualViewport resize (iOS keyboard)");
  assert.ok(/overflowY = over \? "auto" : "hidden"/.test(src), "scrolls internally only once capped");
  assert.ok(!/scrollHeight\) \+ "px"/.test(src.replace(/Math\.min\(full, cap\)/, "")), "no raw scrollHeight growth");
});
test("jump-to-latest wired into DMs/groups and room chat", () => {
  for (const f of ["src/components/chat/DmThread.tsx", "src/components/chat/RoomChatPanel.tsx"]) {
    const src = readFileSync(f, "utf8");
    assert.ok(src.includes("<JumpToLatest"), f);
    assert.ok(src.includes("showJumpButton("), f);
  }
  const btn = readFileSync("src/components/chat/JumpToLatest.tsx", "utf8");
  assert.ok(/aria-label=/.test(btn) && /h-11 w-11/.test(btn), "aria-label + 44px target");
});
