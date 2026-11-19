// BaoTime state colour (Step 2): initiating blue-violet, connected blue-green, failed red, ended slate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baoTone } from "../../src/lib/calls/baoTone";

test("baoTone maps every call screen state", () => {
  for (const ui of ["outgoing", "incoming", "connecting"] as const) assert.equal(baoTone({ ui, reconnecting: false, canRetry: false } as never), "initiating");
  assert.equal(baoTone({ ui: "active", reconnecting: false, canRetry: false } as never), "connected");
  assert.equal(baoTone({ ui: "active", reconnecting: true, canRetry: false } as never), "initiating");
  assert.equal(baoTone({ ui: "ended", reconnecting: false, canRetry: true } as never), "failed");
  assert.equal(baoTone({ ui: "ended", reconnecting: false, canRetry: false } as never), "ended");
});
