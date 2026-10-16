import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type Ev = { type: string; detail?: unknown };
function installWindow(bridge: Record<string, unknown> | null) {
  const target = new EventTarget();
  const w = {
    OpenLoungeNative: bridge ?? undefined,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
  (globalThis as { window?: unknown }).window = w;
  (globalThis as { CustomEvent?: unknown }).CustomEvent ??= class extends Event {
    detail: unknown;
    constructor(t: string, o?: { detail?: unknown }) { super(t); this.detail = o?.detail; }
  };
  return w as typeof w & Record<string, unknown>;
}

function fakeSocket() {
  const handlers = new Map<string, Set<(d: unknown) => void>>();
  const sent: Array<{ ev: string; data: unknown }> = [];
  return {
    sent,
    on(ev: string, fn: (d: unknown) => void) { (handlers.get(ev) ?? handlers.set(ev, new Set()).get(ev)!).add(fn); },
    off(ev: string, fn: (d: unknown) => void) { handlers.get(ev)?.delete(fn); },
    emit(ev: string, d: unknown) { handlers.get(ev)?.forEach((f) => f(d)); },
    async request(ev: string, data: unknown) { sent.push({ ev, data }); return { ok: true, echo: ev }; },
  };
}

test("native media: only the iOS app with the nativeMedia capability, and only audio-only calls", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  installWindow(null);
  assert.equal(m.useNativeMedia(false), false, "Safari / web: never");
  installWindow({ capabilities: ["calls"], nativeMedia: async () => true, msReply() {} });
  assert.equal(m.useNativeMedia(false), false, "older iOS app without the capability");
  installWindow({ capabilities: ["calls", "nativeMedia"], nativeMedia: async () => true, msReply() {} });
  assert.equal(m.useNativeMedia(false), true);
  assert.equal(m.useNativeMedia(true), false, "video calls keep the WebView path");
});

test("native media: page relays the app's ms:* signaling for this call only, forwards consumer notices, maps state", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  const cmds: Record<string, unknown>[] = [];
  const replies: Array<[string, boolean, unknown, string | undefined]> = [];
  const w = installWindow({
    capabilities: ["calls", "nativeMedia"],
    nativeMedia: async (c: Record<string, unknown>) => { cmds.push(c); return c.op === "stats" ? [[{ id: "a", type: "transport" }]] : true; },
    msReply: (id: string, ok: boolean, r: unknown, e?: string) => replies.push([id, ok, r, e]),
  });
  const sock = fakeSocket();
  const states: string[] = [];
  const s = new m.NativeMediaSession(sock as never, { provider: "mediasoup", callId: "c1", iceServers: [{ urls: "turn:x" }] } as never, {
    onRemoteTrack() {}, onState: (st) => states.push(st), onLocalVideo() {}, tcpOnly: true,
  });
  await s.connect(false);
  assert.deepEqual(cmds[0], { op: "connect", callId: "c1", iceServers: [{ urls: "turn:x" }], tcpOnly: true });
  const relay = w.__olNativeMsReq as (id: string, ev: string, d: Record<string, unknown>) => void;
  relay("r1", "ms:join", { callId: "c1" });
  relay("r2", "ms:join", { callId: "other" });
  relay("r3", "auth:verify", { callId: "c1" });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sock.sent, [{ ev: "ms:join", data: { callId: "c1" } }]);
  assert.deepEqual(replies.find((x) => x[0] === "r1")?.slice(0, 2), ["r1", true]);
  assert.equal(replies.find((x) => x[0] === "r2")?.[1], false);
  assert.equal(replies.find((x) => x[0] === "r3")?.[1], false);
  sock.emit("ms:consumer:available", {});
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(cmds.some((c) => c.op === "consumerAvailable"));
  window.dispatchEvent(new CustomEvent("openlounge:native-media", { detail: { state: "disconnected" } }));
  window.dispatchEvent(new CustomEvent("openlounge:native-media", { detail: { state: "connected" } }));
  assert.deepEqual(states, ["disconnected", "connected"]);
  await s.setMuted(true);
  assert.ok(cmds.some((c) => c.op === "mute" && c.muted === true));
  const stats = await s.getTransportStats();
  assert.equal((stats[0] as unknown as Map<string, unknown>).size, 1);
  s.close();
  assert.equal(w.__olNativeMsReq, undefined);
  assert.ok(cmds.some((c) => c.op === "close"));
});

test("engine: native-media mode skips WebView getUserMedia on dial and prewarms the app instead", () => {
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.match(src, /if \(useNativeMedia\(video\)\) \{\s*this\.preMic = Promise\.resolve\(null\);\s*void nativeMediaCmd\(\{ op: "prewarm" \}\)/);
  assert.match(src, /useNativeMedia\([^)]*\) \? NativeMediaSession : MediasoupCallSession/);
});
