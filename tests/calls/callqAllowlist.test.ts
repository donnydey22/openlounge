// FX-082 must-pass: simulcast only for server-allowlisted test accounts; every other user's call media is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { callqGrantFor, callqTestUsers } from "../../server/calls/callqAllowlist";
import { cameraEncodings, setSimulcastGrant, simulcastEnabled } from "../../src/lib/calls/simulcast";

const TEST_IDS = ["u_cc9df5f2-ca15-422e-ba6f-3f1d2909d577", "u_71be5050-35bc-4a38-8436-0ec8ff9b5858", "u_d437878e-c4c4-4cd7-a814-6651aa4a88b5"];

test("callq allowlist: only the 3 existing test accounts by default", () => {
  const u = callqTestUsers({});
  assert.deepEqual([...u].sort(), [...TEST_IDS].sort());
  for (const id of TEST_IDS) assert.deepEqual(callqGrantFor(id, u), { simulcast: true });
  assert.equal(callqGrantFor("u_someone-else", u), null);
  assert.equal(callqTestUsers({ CALLQ_TEST_USER_IDS: "off" }).size, 0);
});

test("callq: non-test users get no grant, the single encoding (undefined), and the exact same media object", () => {
  setSimulcastGrant({ provider: "mediasoup" } as never);
  assert.equal(simulcastEnabled(), false);
  assert.equal(cameraEncodings(), undefined);
  const src = readFileSync("server/calls/service.ts", "utf8");
  assert.match(src, /return callq \? \{ \.\.\.media, callq \} : media;/);
});

test("callq: a granted test account gets 3 layers, and the grant clears on the next non-test media", () => {
  setSimulcastGrant({ callq: { simulcast: true } });
  assert.equal(simulcastEnabled(), true);
  assert.equal(cameraEncodings()!.length, 3);
  setSimulcastGrant(undefined);
  assert.equal(simulcastEnabled(), false);
});
