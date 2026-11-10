// Native call-screen signals: ringing, mediaFlowing, photo on outgoing / answering, foreground incoming.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const e = readFileSync("src/lib/calls/engine.ts", "utf8");
const p = readFileSync("src/components/calls/CallProvider.tsx", "utf8");

test("call:outgoing includes photo from peer.photoUrl", () => {
  assert.match(e, /postNative\(\{ type: "call:outgoing", callId: r\.call\.id, name: peer\.name, photo: peer\.photoUrl \|\| ""/);
});

test("call:answering includes the caller's name and photo", () => {
  assert.match(e, /postNative\(\{ type: "call:answering", callId: call\.id, name: call\.caller\?\.name \|\| "", photo: call\.caller\?\.photoUrl \|\| "", video:/);
});

test("page posts call:ringing when the server ringing ack reaches the caller", () => {
  assert.match(e, /postNative\(\{ type: "call:ringing", callId \}\)/);
  assert.match(e, /if \(call\.phase === "ringing" && role === "caller" && this\.s\.ui === "outgoing"\)[\s\S]*?this\.postRinging\(call\.id\)/);
});

test("page posts call:mediaFlowing once on first media after answer", () => {
  assert.match(e, /postNative\(\{ type: "call:mediaFlowing", callId \}\)/);
  assert.match(e, /if \(!callId \|\| this\.mediaFlowPosted\) return;/);
  assert.match(e, /this\.mediaFlowPosted = true;/);
});

test("CallProvider posts call:incoming in the foreground", () => {
  assert.match(p, /type: "call:incoming"/);
  assert.doesNotMatch(p, /if \(!appVisible\(\) && lastIncomingNative/);
  assert.match(p, /if \(lastIncomingNative\.current !== s\.call\.id\)/);
});
