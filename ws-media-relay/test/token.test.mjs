import test from "node:test"; import assert from "node:assert/strict";
import { mintRelayToken, verifyRelayToken } from "../src/token.mjs";
test("relay token pins target and rejects tampering", () => {
  const t = mintRelayToken("s", { userId: "u", callId: "c", host: "1.2.3.4", port: 39001 });
  assert.equal(verifyRelayToken("s", t).p, 39001);
  assert.equal(verifyRelayToken("x", t), null);
  assert.equal(verifyRelayToken("s", t.replace(/^./, "A")), null);
});
