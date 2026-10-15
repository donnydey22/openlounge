import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

test("warm native Accept: page exposes __olAcceptCall and falls back (false) when it can't accept in place", () => {
  const src = read("../../src/components/calls/CallProvider.tsx");
  assert.match(src, /__olAcceptCall = \(callId: string\) =>/);
  assert.match(src, /if \(!socket\?\.connected\) return false;/);
  assert.match(src, /e_\.openFromLink\(callId, true\)/);
});

test("peer signalling drop while media flows does not flash reconnecting immediately", () => {
  const src = read("../../src/lib/calls/engine.ts");
  assert.match(src, /PEER_OFFLINE_GRACE_MS = 15_000/);
  assert.match(src, /if \(!this\.mediaConnected\(\)\) return this\.set\(\{ peerReconnecting: true \}\)/);
});
