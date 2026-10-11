import test from "node:test";
import assert from "node:assert/strict";
import { mintMediasoupAdmission, verifyMediasoupAdmission } from "../../server/mediasoup/admission";

const secret = "s".repeat(40);
const input = { callId: "call-123", userId: "user-456", nonce: "nonce_12345678", ttlSec: 60 };

test("Mediasoup admission tokens are short-lived, signed, and call/user scoped", () => {
  const token = mintMediasoupAdmission(input, { secret, nowMs: 1_000_000 });
  assert.ok(token);
  const verified = verifyMediasoupAdmission(token, { secret, nowMs: 1_030_000 });
  assert.deepEqual(verified, { ok: true, claims: { v: 1, callId: input.callId, userId: input.userId, nonce: input.nonce, exp: 1060 } });
});

test("Mediasoup admission rejects tampering, expiry, and missing server secret", () => {
  const token = mintMediasoupAdmission(input, { secret, nowMs: 1_000_000 });
  assert.ok(token);
  assert.deepEqual(verifyMediasoupAdmission(`${token!.slice(0, -1)}x`, { secret, nowMs: 1_001_000 }), { ok: false, reason: "signature" });
  assert.deepEqual(verifyMediasoupAdmission(token, { secret, nowMs: 1_061_000 }), { ok: false, reason: "expired" });
  assert.equal(mintMediasoupAdmission(input, { secret: "short", nowMs: 1_000_000 }), null);
  assert.deepEqual(verifyMediasoupAdmission(token, { secret: "short", nowMs: 1_001_000 }), { ok: false, reason: "disabled" });
});
