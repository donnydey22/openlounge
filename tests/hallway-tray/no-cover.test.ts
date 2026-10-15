import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("src/app/globals.css", "utf8");
const mini = readFileSync("src/components/room/LiveRoomProvider.tsx", "utf8");
const dmPage = readFileSync("src/app/messages/[peerId]/page.tsx", "utf8");
const group = readFileSync("src/components/groups/GroupScreen.tsx", "utf8");
const sheet = readFileSync("src/components/Sheet.tsx", "utf8");
const home = readFileSync("src/app/page.tsx", "utf8");
const notif = readFileSync("src/components/Notifier.tsx", "utf8");
const dmThread = readFileSync("src/components/chat/DmThread.tsx", "utf8");

test("CSS publishes --ol-liveroom-bar-h and reserves space on screens/docks/sheets", () => {
  assert.match(css, /--ol-liveroom-bar-h/);
  assert.match(css, /html\[data-live-room-bar\]\s+\.app-shell/);
  assert.match(css, /\[data-ol-screen\]/);
  assert.match(css, /\[data-ol-bottom-dock\]/);
  assert.match(css, /\[data-ol-sheet\]/);
  assert.match(css, /\[data-ol-notif\]/);
  assert.match(css, /\[data-ol-bottom-pad\]/);
});

test("LiveRoomMiniBar measures height and pins to visualViewport", () => {
  assert.match(mini, /barRef/);
  assert.match(mini, /ResizeObserver/);
  assert.match(mini, /--ol-liveroom-bar-h/);
  assert.match(mini, /visualViewport/);
  assert.match(mini, /data-testid="live-room-bar"/);
});

test("key surfaces opt into reservation markers", () => {
  assert.match(dmPage, /data-ol-screen/);
  assert.match(group, /data-ol-screen/);
  assert.match(group, /data-ol-bottom-pad/);
  assert.match(dmThread, /data-ol-bottom-pad/);
  assert.match(home, /data-ol-bottom-dock/);
  assert.match(sheet, /data-ol-sheet/);
  assert.match(notif, /data-ol-notif/);
});
