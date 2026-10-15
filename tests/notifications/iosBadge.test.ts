// iOS badge parity: Android's data-message path always applied badge clears; iOS got a background push whose
// aps.badge is ignored/throttled (and dropped for a killed app), and the web never re-asserted the icon on resume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("iOS clear push with a badge is a badge-only ALERT push (applied by iOS even when the app is killed)", () => {
  const s = readFileSync("server/push/sender.ts", "utf8");
  assert.match(s, /"apns-push-type": "alert", "apns-priority": "5" }, payload: { aps: { badge: msg\.badge } }/);
});

test("resume re-asserts the native badge and reconnects a dead iOS socket before refreshing the total", () => {
  const s = readFileSync("src/components/AppProvider.tsx", "utf8");
  assert.match(s, /native\(\)\?\.setBadge\?\.\(unreadRef\.current\);[\s\S]{0,80}refreshUnread\(\)/);
  assert.match(s, /if \(!s\.connected\) return void s\.wake\(\);[\s\S]{0,40}s\.request<[^>]+>\("conv:list"/);
});
