import { test } from "node:test";
import assert from "node:assert/strict";
import { biometricsBridge, readBiometrics, setBiometrics } from "../../src/lib/biometrics";

const mk = (avail: boolean, start: boolean, promptOk = true) => {
  let on = start;
  return {
    isAvailable: () => Promise.resolve(avail),
    getEnabled: () => Promise.resolve(on),
    setEnabled: (v: boolean) => Promise.resolve((on = v ? avail && promptOk : false)),
  };
};

test("no bridge → hidden", () => {
  assert.equal(biometricsBridge({}), null);
  assert.equal(biometricsBridge({ OpenLoungeNative: { getSession() {} } }), null);
  assert.equal(biometricsBridge(undefined), null);
});

test("iOS shape and Android mirror are detected", () => {
  const b = mk(true, false);
  assert.equal(biometricsBridge({ OpenLoungeNative: { biometrics: b } }), b);
  assert.equal(biometricsBridge({ OpenLoungeNative: {}, OpenLoungeBiometrics: b }), b);
});

test("unavailable device reports disabled", async () => {
  assert.deepEqual(await readBiometrics(mk(false, true)), { available: false, enabled: false });
});

test("enable requires successful prompt", async () => {
  assert.equal(await setBiometrics(mk(true, false, false), true), false);
  assert.equal(await setBiometrics(mk(true, false, true), true), true);
  assert.equal(await setBiometrics(mk(true, true), false), false);
});

test("bridge errors are swallowed", async () => {
  const bad = { isAvailable: () => Promise.reject(new Error("x")), getEnabled: () => true, setEnabled: () => { throw new Error("y"); } };
  assert.deepEqual(await readBiometrics(bad), { available: false, enabled: false });
  assert.equal(await setBiometrics(bad, true), false);
});
