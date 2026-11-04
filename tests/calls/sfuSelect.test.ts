import test from "node:test";
import assert from "node:assert/strict";
import { sfuSelected } from "../../server/calls/sfuSelect";

const p = { callerId: "u_a", calleeId: "u_b" };
test("SFU selected for everyone (LiveKit calling removed 11/4)", () => {
  for (const env of [{ CALL_SFU: "layered" }, {}, { CALL_SFU_TEST_USERS: "u_a" }]) assert.equal(sfuSelected(p, env), true);
});
