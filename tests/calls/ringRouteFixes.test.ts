import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const idx = readFileSync("server/calls/index.ts", "utf8");
const eng = readFileSync("src/lib/calls/engine.ts", "utf8");

test("ring retry skips iOS when the VoIP/CallKit push already rang", () => {
  assert.match(idx, /if \(rang > 0\) \{\s*voipRang\.add\(call\.id\)/);
  assert.match(idx, /repush:[\s\S]{0,300}skipIos: voipRang\.has\(call\.id\)/);
});

test("first ring still sends iOS alert when VoIP did not ring", () => {
  assert.match(idx, /skipIos: rang > 0, declineToken/);
});

test("app video call that lands on earpiece without a user pick is put back on speaker once", () => {
  assert.match(eng, /this\.routeUserPick \|\| this\.routeReasserted \|\| route\.kind !== "earpiece" \|\| !\(this\.s\.camOn \|\| this\.s\.call\?\.video\)/);
  assert.match(eng, /this\.diag\("route init"/);
  assert.match(eng, /this\.diag\("route user"/);
});

test("app sends the video flag with call:connected (iOS in-app answer activation)", () => {
  assert.match(eng, /type: "call:connected", callId: this\.s\.call\?\.id, video:/);
});
