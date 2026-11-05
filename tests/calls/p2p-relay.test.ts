import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
test("call:p2p is a verbatim forwarder to the other participant, bounded, schema-validated", () => {
  const svc = readFileSync("server/calls/service.ts", "utf8"), idx = readFileSync("server/calls/index.ts", "utf8"), sch = readFileSync("server/wsSchemas.ts", "utf8");
  assert.match(svc, /p2p\(callId: unknown, userId: string, msg: unknown\)/);
  assert.match(svc, /json\.length > 8192/);
  assert.match(svc, /emitUser\(other, "call:p2p"/);
  assert.match(idx, /socket\.on\("call:p2p"/);
  assert.match(sch, /"call:p2p": \{ callId: "id" \}/);
});
