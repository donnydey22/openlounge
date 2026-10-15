import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Keiko 2026-10-15 04:30 PT: fresh-install mic permission prompt was billed against the 8 s UDP budget → TCP fallback.
test("mic permission prompt and mediasoup-client load do not spend the 8 s UDP connect budget", () => {
  const src = fs.readFileSync("src/lib/calls/mediasoupSession.ts", "utf8");
  assert.match(src, /const CONNECT_TIMEOUT_MS = 8_000;/);
  assert.match(src, /this\.local\(\(\) => navigator\.mediaDevices\.getUserMedia\(\{ audio: CALL_AUDIO_CONSTRAINTS \}\)\)/);
  assert.match(src, /this\.local\(\(\) => import\("mediasoup-client"\)\)/);
  assert.match(src, /CONNECT_HARD_CAP_MS = 30_000/);
});

test("no TCP fallback while UDP ICE is still progressing (bounded by the hard cap)", () => {
  const src = fs.readFileSync("src/lib/calls/mediasoupSession.ts", "utf8");
  assert.match(src, /st === "connecting" \|\| st === "new"/);
  assert.match(src, /ICE_PROGRESS_GRACE_MS = 2_000/);
});
