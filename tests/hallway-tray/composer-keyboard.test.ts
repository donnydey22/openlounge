// Composer + live-room tray: keyboard-open (focus) must not stack tray height on the inset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const shell = readFileSync("src/components/AppShell.tsx", "utf8");
const css = readFileSync("src/app/globals.css", "utf8");
const mini = readFileSync("src/components/room/LiveRoomProvider.tsx", "utf8");
const dm = readFileSync("src/app/messages/[peerId]/page.tsx", "utf8");

test("AppShell marks data-kbd on visualViewport overlay and on focused-field layout shrink", () => {
  assert.match(shell, /setAttribute\("data-kbd"/);
  assert.match(shell, /visualViewport/);
  assert.match(shell, /focusin/);
  assert.match(shell, /focusout/);
  assert.match(shell, /overlay/);
  assert.match(shell, /resized/);
  assert.match(shell, /focusedField/);
});

test("DM screen still sizes itself to visualViewport (composer docks to the keyboard)", () => {
  assert.match(dm, /useVisualViewport/);
  assert.match(dm, /data-ol-screen/);
  assert.match(dm, /v\.height/);
});

test("tray reservation is released while the keyboard is open and restored when it closes", () => {
  assert.match(css, /html\[data-kbd\]\[data-live-room-bar\]/);
  assert.match(css, /--ol-liveroom-bar-h:\s*0px\s*!important/);
  assert.match(css, /html\[data-kbd\] \[data-ol-live-room-bar\]/);
  assert.match(css, /visibility:\s*hidden/);
  // keyboard-closed reservation (tray must not cover UI) is unchanged
  assert.match(css, /html\[data-live-room-bar\] \[data-ol-screen\]/);
  assert.match(mini, /kbdOpen \? "0px" : `\$\{height\}px`/);
});
