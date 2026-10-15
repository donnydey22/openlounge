import { test } from "node:test";
import assert from "node:assert/strict";
import { isCallPolicyTestPair } from "../../server/store";
const DONNY = "u_05c86a26-3707-4c45-9147-bdbdd0189b58";
const JORDAN = "u_71be5050-35bc-4a38-8436-0ec8ff9b5858";
const SAM = "u_d437878e-0000-4000-8000-000000000000";
test("Sam and Jordan may call Donny without message/follow-back", () => {
  assert.equal(isCallPolicyTestPair(JORDAN, DONNY), true);
  assert.equal(isCallPolicyTestPair(SAM, DONNY), true);
});
test("exception does not loosen the rule for anyone else", () => {
  assert.equal(isCallPolicyTestPair("u_someone-else", DONNY), false);
  assert.equal(isCallPolicyTestPair(JORDAN, "u_other"), false);
  assert.equal(isCallPolicyTestPair(DONNY, JORDAN), false);
  assert.equal(isCallPolicyTestPair(DONNY, SAM), false);
});
