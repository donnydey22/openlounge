// Oct 31: ring-start / ring-stop diag with reasons; call:answering at the Accept tap; failed end tells native.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const e = readFileSync("src/lib/calls/engine.ts", "utf8");
test("ring-start for ringtone and ringback", () => {
  assert.match(e, /playRingtone\(\{ video: call\.video, untilMs: ringUntil\(call\) \}\);\s*this\.diag\("ring-start", \{ tone: "ringtone" \}\)/);
  assert.match(e, /this\.diag\("ring-start", \{ tone: "ringback" \}\)/);
});
test("ring-stop reasons", () => {
  for (const r of ["accept", "decline", "answered-elsewhere", "glare"]) assert.ok(e.includes(`this.ringStop("${r}")`), r);
  assert.match(e, /this\.ringStop\(outcome === "cancelled" \|\| outcome === "missed" \? "cancel" : "end"\)/);
});
test("accept posts call:answering before media; failed end carries reason", () => {
  assert.match(e, /this\.diag\("answered", \{\}\);\s*\/\/[^\n]*\n\s*postNative\(\{ type: "call:answering"/);
  assert.match(e, /outcome === "failed" \? \{ reason: "failed" \} : \{\}/);
});
