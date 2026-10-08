import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeNative, decodeParked, encodeNative, encodeParked } from "../../src/lib/session";
import { biometricAuthenticate, quickSignInReady } from "../../src/lib/biometrics";

const creds = { refresh: "r".repeat(40), access: "a".repeat(30), accessExp: 1, uid: "u_1", savedAt: 5 };

test("a parked session is never adopted as a live one", () => {
  const raw = encodeParked(creds, "donny", "Donny");
  assert.equal(decodeNative(raw), null);
  const p = decodeParked(raw)!;
  assert.equal(p.username, "donny");
  assert.equal(p.creds.refresh, creds.refresh);
  assert.equal(p.creds.access, null, "access token is not kept");
  assert.equal(decodeParked(encodeNative(creds)), null);
  assert.equal(decodeParked("garbage"), null);
});

const bridge = (enabled: boolean, auth?: () => unknown) => ({
  isAvailable: () => true,
  getEnabled: () => enabled,
  setEnabled: () => enabled,
  ...(auth ? { authenticate: auth } : {}),
});

test("quick sign-in needs App lock on AND authenticate()", async () => {
  assert.equal(await quickSignInReady(null), false);
  assert.equal(await quickSignInReady(bridge(true) as never), false, "old shells (no authenticate) keep the old sign-out");
  assert.equal(await quickSignInReady(bridge(false, () => true) as never), false);
  assert.equal(await quickSignInReady(bridge(true, () => true) as never), true);
});

test("authenticate: only a literal true passes; errors fail closed", async () => {
  assert.equal(await biometricAuthenticate(bridge(true, () => Promise.resolve(true)) as never), true);
  assert.equal(await biometricAuthenticate(bridge(true, () => "true") as never), false);
  assert.equal(await biometricAuthenticate(bridge(true, () => Promise.reject(new Error("x"))) as never), false);
});
