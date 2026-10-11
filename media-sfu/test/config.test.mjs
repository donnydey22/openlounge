import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config.mjs";

const base = () => ({
  OPENLOUNGE_GATEWAY_WS_URL: "wss://staging.openlounge.app/ws",
  OPENLOUNGE_GATEWAY_HOST: "staging.openlounge.app",
  MEDIASOUP_GATEWAY_SECRET: "g".repeat(32),
  MEDIASOUP_ADMISSION_SECRET: "a".repeat(32),
  MEDIASOUP_ANNOUNCED_ADDRESS: "203.0.113.10",
});

test("accepts the isolated default UDP port envelope", () => {
  const cfg = readConfig(base());
  assert.equal(cfg.minPort, 40000);
  assert.equal(cfg.maxPort, 49999);
  assert.equal(cfg.healthHost, "127.0.0.1");
  assert.equal(cfg.maxSessions, 4);
});

test("rejects coturn listener and relay-port overlap", () => {
  assert.throws(() => readConfig({ ...base(), MEDIASOUP_RTC_MIN_PORT: "443", MEDIASOUP_RTC_MAX_PORT: "45000" }), /coturn listener/);
  assert.throws(() => readConfig({ ...base(), MEDIASOUP_RTC_MIN_PORT: "49999", MEDIASOUP_RTC_MAX_PORT: "50000" }), /coturn relay/);
});

test("rejects weak secret material and non-public announced addresses", () => {
  assert.throws(() => readConfig({ ...base(), MEDIASOUP_GATEWAY_SECRET: "short" }), /32 bytes/);
  assert.throws(() => readConfig({ ...base(), MEDIASOUP_ANNOUNCED_ADDRESS: "0.0.0.0" }), /public/);
});

test("requires encrypted, allowlisted gateway control transport and bounded sessions", () => {
  assert.throws(() => readConfig({ ...base(), OPENLOUNGE_GATEWAY_WS_URL: "ws://staging.openlounge.app/ws" }), /wss/);
  assert.throws(() => readConfig({ ...base(), OPENLOUNGE_GATEWAY_WS_URL: "wss://other.example/ws" }), /must match/);
  assert.throws(() => readConfig({ ...base(), OPENLOUNGE_GATEWAY_WS_URL: "wss://user:pass@staging.openlounge.app/ws" }), /credentials/);
  assert.throws(() => readConfig({ ...base(), MEDIASOUP_MAX_SESSIONS: "5" }), /two sessions/);
});
