import test from "node:test";
import assert from "node:assert/strict";
import { sfuSelected } from "../../server/calls/sfuSelect";

const p = { callerId: "u_a", calleeId: "u_b" };
test("CALL_SFU=layered selects UDP for everyone", () => assert.equal(sfuSelected(p, { CALL_SFU: "layered" }), true));
test("unset flag + no allowlist stays on LiveKit", () => assert.equal(sfuSelected(p, {}), false));
test("allowlist needs BOTH participants", () => {
  assert.equal(sfuSelected(p, { CALL_SFU_TEST_USERS: "u_a, u_b" }), true);
  assert.equal(sfuSelected(p, { CALL_SFU_TEST_USERS: "u_a" }), false);
  assert.equal(sfuSelected({ callerId: "u_x", calleeId: "u_b" }, { CALL_SFU_TEST_USERS: "u_a,u_b" }), false);
  assert.equal(sfuSelected(undefined, { CALL_SFU_TEST_USERS: "u_a,u_b" }), false);
  assert.equal(sfuSelected(p, { CALL_SFU_TEST_USERS: "" }), false);
});
