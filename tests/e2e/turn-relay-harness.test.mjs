import assert from "node:assert/strict";
import test from "node:test";
import { readRelayHarnessConfig, sanitizedSummary } from "./turn-relay-harness.mjs";

const now = Date.UTC(2026, 9, 11, 9, 0, 0);
const validEnv = () => ({
  TURN_RELAY_TEST_STAGING_URL: "https://turn-review.openlounge.test/call-lab",
  TURN_RELAY_TEST_ALLOWED_HOST: "turn-review.openlounge.test",
  TURN_RELAY_TEST_URLS: "turn:turn.openlounge.app:3478?transport=udp,turn:turn.openlounge.app:3478?transport=tcp,turns:turn.openlounge.app:443?transport=tcp",
  TURN_RELAY_TEST_USERNAME: "1791709800:call-abcdefghijklmnopqrstuvwx12345678",
  TURN_RELAY_TEST_CREDENTIAL: "short-lived-test-credential",
});

test("relay harness accepts an explicitly allowlisted staging target and short-lived REST credential", () => {
  const config = readRelayHarnessConfig(validEnv(), now);
  assert.equal(config.allowedHost, "turn-review.openlounge.test");
  assert.equal(config.browser, "chromium");
  assert.equal(config.iceServers[0].urls.length, 3);
  assert.equal(config.iceServers[0].credentialType, "password");
  assert.deepEqual(sanitizedSummary(config), {
    stagingHost: "turn-review.openlounge.test",
    browser: "chromium",
    turnUrlCount: 3,
    timeoutMs: 45_000,
  });
});

test("relay harness rejects every known production host, including DNS trailing dots", () => {
  for (const host of ["openlounge.app", "www.openlounge.app", "openlounge-production.up.railway.app"]) {
    for (const candidateHost of [host, `${host}.`]) {
      const production = validEnv();
      production.TURN_RELAY_TEST_STAGING_URL = `https://${candidateHost}`;
      production.TURN_RELAY_TEST_ALLOWED_HOST = candidateHost;
      assert.throws(() => readRelayHarnessConfig(production, now), /production host/, candidateHost);
    }
  }
});

test("relay harness rejects a mismatched staging host", () => {
  const mismatched = validEnv();
  mismatched.TURN_RELAY_TEST_ALLOWED_HOST = "other-review.openlounge.test";
  assert.throws(() => readRelayHarnessConfig(mismatched, now), /exactly match/);
});

test("relay harness rejects non-TURN URLs and credentials that are not short-lived", () => {
  const nonTurn = validEnv();
  nonTurn.TURN_RELAY_TEST_URLS = "https://turn.openlounge.app";
  assert.throws(() => readRelayHarnessConfig(nonTurn, now), /credential-free turn/);

  const expired = validEnv();
  expired.TURN_RELAY_TEST_USERNAME = "1791709201:call-abcdefghijklmnopqrstuvwx12345678";
  assert.throws(() => readRelayHarnessConfig(expired, now), /expires too soon/);

  const longLived = validEnv();
  longLived.TURN_RELAY_TEST_USERNAME = "1791710401:call-abcdefghijklmnopqrstuvwx12345678";
  assert.throws(() => readRelayHarnessConfig(longLived, now), /short-lived/);
});

test("relay harness does not use or expose a static TURN secret", () => {
  const env = { ...validEnv(), TURN_STATIC_SECRET: "must-not-be-read" };
  const config = readRelayHarnessConfig(env, now);
  assert.equal("TURN_STATIC_SECRET" in config, false);
  assert.equal(JSON.stringify(sanitizedSummary(config)).includes("must-not-be-read"), false);
});
