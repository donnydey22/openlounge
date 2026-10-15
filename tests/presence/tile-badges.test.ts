import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// Presence dot owns the bottom-right corner; tile badges must never sit there.
const tile = readFileSync("src/components/room/ParticipantTile.tsx", "utf8");
const avatar = readFileSync("src/components/Avatar.tsx", "utf8");
test("room tile mute / raised-hand badges stay clear of the bottom-right presence dot", () => {
  for (const src of [tile, avatar]) assert.doesNotMatch(src, /-right-1 -bottom-1/);
  assert.match(tile, /-left-1 -bottom-1 z-\[3\][^"]*h-7/); // self mic toggle: bottom-left
  assert.match(tile, /-left-1 -top-1 z-\[3\][^"]*bg-amber-400/); // raised hand: top-left
  assert.match(avatar, /-left-1 -bottom-1 z-\[2\][^"]*bg-zinc-800/); // muted badge: bottom-left
  assert.match(avatar, /right: `calc\(13% - /); // dot still bottom-right
});
