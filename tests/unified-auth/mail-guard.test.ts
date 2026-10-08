import { test } from "node:test";
import assert from "node:assert/strict";
import { isReservedAddress } from "../../server/authx/mailGuard";

test("reserved / test domains are never mailed", () => {
  for (const a of ["ol-smoke-firefox-1@example.com", "x@EXAMPLE.org", "a@foo.example.net", "a@b.test", "a@x.invalid", "a@host.localhost", "a@localhost", "nodomain", ""]) assert.equal(isReservedAddress(a), true, a);
  for (const a of ["outthereendlessly@gmail.com", "me@openlounge.app", "a@examples.com", "a@example.co", "a@test.com"]) assert.equal(isReservedAddress(a), false, a);
});
