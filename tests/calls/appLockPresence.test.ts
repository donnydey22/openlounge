import { test } from "node:test";
import assert from "node:assert/strict";
import { isCallAcceptPath } from "../../src/lib/calls/appLockPresence";

test("isCallAcceptPath recognizes call deep links", () => {
  assert.equal(isCallAcceptPath(null), false);
  assert.equal(isCallAcceptPath(""), false);
  assert.equal(isCallAcceptPath("/messages/u_1"), false);
  assert.equal(isCallAcceptPath("/call/abc123"), true);
  assert.equal(isCallAcceptPath("/call/abc123?accept=1"), true);
  assert.equal(isCallAcceptPath("/call/abc123?foo=1&accept=1"), true);
  assert.equal(isCallAcceptPath("/callback"), false);
  assert.equal(isCallAcceptPath("https://openlounge.app/call/x"), false);
});
