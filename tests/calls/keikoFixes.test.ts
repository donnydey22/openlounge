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

test("mic muted by an OS session handover is recaptured; ended too", () => {
  const src = readFileSync(new URL("../../src/lib/calls/mediasoupSession.ts", import.meta.url), "utf8");
  assert.ok(src.includes('addEventListener("mute", this.onMicMuted)'));
  assert.ok(/checkMicAlive\(\)[\s\S]{0,200}this\.mic\.muted\) void this\.recoverMic\(\)/.test(src));
});

test("glare: a start() that returns the peer's ringing call answers it", () => {
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.match(src, /r\.call\.callerId !== this\.meId && r\.call\.calleeId === this\.meId[\s\S]{0,600}await this\.accept\(video\)/);
});

test("foreground return re-checks the mic", () => {
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.match(src, /onVisibleCallAudio = \(\) => \{[\s\S]{0,300}checkMicAlive\(\)/);
});

test("caller mic handover: CallKit/connected reasons rebind the existing producer; pending until it exists", () => {
  const eng = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  const ms = readFileSync(new URL("../../src/lib/calls/mediasoupSession.ts", import.meta.url), "utf8");
  for (const r of ["callkit-activate", "callkit-activate-settle", "connected", "interruption-ended"]) assert.ok(eng.includes(`"${r}"`));
  assert.match(eng, /role === "caller" && MIC_HANDOVER_REASONS\.has\(reason\)[\s\S]{0,300}rebindMic\(\)[\s\S]{0,80}micHandoverPending = true/);
  assert.match(eng, /this\.mediasoup = session;\s*if \(this\.micHandoverPending\)[\s\S]{0,120}session\.rebindMic\(\)/);
  assert.match(ms, /rebindMic\(\) \{[\s\S]{0,400}replaceTrack|rebindMic\(\) \{[\s\S]{0,900}this\.recoverMic\(\)/);
  assert.match(ms, /this\.producers\.set\("audio", producer\);\s*if \(this\.micHandoverPending\)/);
});
