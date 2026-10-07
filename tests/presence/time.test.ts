// lastSeen relative + absolute labels derive from one timestamp and the skew-corrected clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAgo, formatClock, recordClockSample, serverNow, TICK_MS, bumpClock } from "../../src/lib/time";

test("tick is 30 s and bumpClock exists", () => {
  assert.equal(TICK_MS, 30_000);
  assert.equal(typeof bumpClock, "function");
});

test("skewed client clock: relative and absolute agree after a sync sample", () => {
  // device clock 9 min fast
  const skew = 9 * 60_000;
  const serverClock = Date.now();
  const t0 = serverClock + skew;
  recordClockSample(t0, serverClock, t0 + 10);
  assert.ok(Math.abs(serverNow() - Date.now() - -skew) < 50);
  const lastSeen = serverNow() - 60_000; // server epoch ms
  assert.equal(formatAgo(lastSeen), "1m");
  // absolute is formatted from the same value in the device zone
  assert.equal(formatClock(lastSeen), new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(lastSeen));
});
