// FX-064: b67 app media diagnostics reach the Railway log (consume results, first remote video frame, ICE recovery).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

(globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {} };
const load = () => import("../../src/lib/calls/nativeMediaSession");

const mk = async (got: Array<[string, unknown]>) =>
  new (await load()).NativeMediaSession({ on() {}, off() {}, request: async () => ({ ok: true }) } as never, { provider: "mediasoup", callId: "c1" } as never, {
    onRemoteTrack() {}, onState() {}, onLocalVideo() {}, callId: "c1",
    onNativeDiag: (ev: string, data: unknown) => got.push([ev, data]),
  } as never);

test("native diag forward: known events for this call reach onNativeDiag with scalar fields only", async () => {
  const got: Array<[string, unknown]> = [];
  const s = (await mk(got)) as unknown as { forwardNativeDiag(d: Record<string, unknown>): void };
  s.forwardNativeDiag({ state: "media-diag", callId: "c1", ev: "consume-result", n: 2, kinds: "audio,video", secret: "x" });
  s.forwardNativeDiag({ state: "media-diag", callId: "c1", ev: "first-remote-video-frame", ms: 640 });
  s.forwardNativeDiag({ state: "media-diag", callId: "c1", ev: "no-remote-video-frame", ms: 20000 });
  s.forwardNativeDiag({ state: "media-diag", callId: "c1", ev: "ice-recovered", consumers: 2 });
  s.forwardNativeDiag({ state: "media-diag", callId: "OTHER", ev: "consume-result", n: 0 });
  s.forwardNativeDiag({ state: "media-diag", callId: "c1", ev: "anything-else", n: 1 });
  assert.deepEqual(got, [
    ["consume-result", { n: 2, kinds: "audio,video" }],
    ["first-remote-video-frame", { ms: 640 }],
    ["no-remote-video-frame", { ms: 20000 }],
    ["ice-recovered", { consumers: 2 }],
  ]);
  assert.equal((await load()).NATIVE_DIAG_EVENTS.size, 10);
});

test("native diag forward: engine logs them as native-<ev> call diags, and media-diag never changes call state", () => {
  const eng = readFileSync("src/lib/calls/engine.ts", "utf8");
  assert.match(eng, /onNativeDiag: \(ev: string, data[^)]*\) => \{\n\s*if \(this\.mediasoup !== session\) return;\n\s*this\.netLog\(`native-\$\{ev\}`, data\);\n\s*this\.diag\(`native-\$\{ev\}`, data\);/);
  const nm = readFileSync("src/lib/calls/nativeMediaSession.ts", "utf8");
  assert.match(nm, /if \(s === "media-diag"\) \{\n\s*this\.forwardNativeDiag\(d as Record<string, unknown>\);\n\s*return;/);
});

test("FX-064: b68 per-kind resume / replacement diag events are forwarded", async () => {
  const { NATIVE_DIAG_EVENTS } = await import("../../src/lib/calls/nativeMediaSession");
  for (const ev of ["consumer-resumed", "resume-failed", "remote-video-replaced"]) assert.ok(NATIVE_DIAG_EVENTS.has(ev), ev);
});
