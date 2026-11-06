import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("accepted call id survives a page reload (sessionStorage) for callee rejoin", async () => {
  const store = new Map<string, string>();
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k),
  };
  const { rememberAccepted, acceptedBefore } = await import("../../src/lib/calls/engine");
  rememberAccepted("call-1234");
  assert.equal(acceptedBefore("call-1234"), true);
  assert.equal(acceptedBefore("other-999"), false);
  rememberAccepted(null);
  assert.equal(acceptedBefore("call-1234"), false);
});

test("native wrappers never hang up from pagehide (unlock reload dropped answered calls)", () => {
  const src = readFileSync(new URL("../../src/components/calls/CallProvider.tsx", import.meta.url), "utf8");
  const i = src.indexOf('addEventListener("pagehide"');
  const handler = src.slice(src.lastIndexOf("const onHide", i), i);
  assert.ok(/__olNativeCalls[^\n]*\) return;/.test(handler), "pagehide returns early inside native wrappers");
  assert.ok(handler.indexOf("__olNativeCalls") < handler.indexOf('"call:hangup"'));
});

test("glare: a start() that returns the peer's ringing call answers it", () => {
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.match(src, /r\.call\.callerId !== this\.meId && r\.call\.calleeId === this\.meId[\s\S]{0,600}await this\.accept\(video\)/);
});

test("resume retries when call:current acks ok:false (socket not authed yet after a WebView reload)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  const assert = (await import("node:assert/strict")).default;
  assert.match(src, /async resume\(attempt = 0\)[\s\S]{0,300}if \(!r\.ok\)[\s\S]{0,400}this\.resume\(attempt \+ 1\)/);
});
