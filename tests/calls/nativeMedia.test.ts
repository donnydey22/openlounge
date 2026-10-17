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
  // still no WebView getUserMedia; the app prewarm runs at dial unless the loud native ringback owns the session
  // (then prewarm + native SFU join wait for the answer — Oct 17 ring loud→quiet fix)
  assert.match(src, /if \(useNativeMedia\(video\)\) \{\s*this\.preMic = Promise\.resolve\(null\);[\s\S]{0,400}?this\.deferNativeConnect = nativeRingbackMode\(\) !== "off";\s*if \(!this\.deferNativeConnect\) void nativeMediaCmd\(\{ op: "prewarm" \}\)/);
  assert.match(src, /if \(this\.deferNativeConnect\) \{\s*this\.deferNativeConnect = false;\s*void this\.connect\(false\);/);
  assert.match(src, /useNativeMedia\([^)]*\) \? NativeMediaSession : MediasoupCallSession/);
});

test("server: native SFU connection is stable across page sockets and survives a reload window", async () => {
  const m = await import("../../server/calls/index");
  assert.equal(m.nativeConnectionFor("sock1", "u1", undefined), "sock1", "web path unchanged");
  assert.equal(m.nativeConnectionFor("sock1", "u1", "bad id!"), null);
  const id = m.nativeConnectionFor("sock1", "u1", "n_abc12345");
  assert.equal(id, "native:u1:n_abc12345");
  const expired: string[] = [];
  m.nativeSocketClosed("sock1", (c: string) => void expired.push(c), 30);
  // reloaded page relays again from a new socket before the window ends → no teardown
  assert.equal(m.nativeConnectionFor("sock2", "u1", "n_abc12345"), id);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(expired.length, 0);
  // app gone: the new socket closes and nobody re-attaches → torn down
  m.nativeSocketClosed("sock2", (c: string) => void expired.push(c), 20);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(expired, [id]);
  assert.equal(m.nativeConnectionFor("sockX", "u2", "n_abc12345"), "native:u2:n_abc12345", "scoped per authenticated user");
});

test("native media: emergency LiveKit is joined by the app; page never captures the mic in native mode", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  const cmds: Record<string, unknown>[] = [];
  installWindow({ capabilities: ["calls", "nativeMedia"], nativeMedia: async (c: Record<string, unknown>) => { cmds.push(c); return true; }, msReply() {} });
  const s = new m.NativeMediaSession(fakeSocket() as never, { provider: "livekit", url: "wss://lk", token: "t", iceServers: [] } as never, {
    onRemoteTrack() {}, onState() {}, onLocalVideo() {}, callId: "c9",
  });
  await s.connect(false);
  assert.deepEqual(cmds[0], { op: "connectLiveKit", callId: "c9", url: "wss://lk", token: "t", iceServers: [] });
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.match(src, /media\.provider === "mediasoup" \|\| useNativeMedia\(/);
  assert.match(src, /provider === "livekit" && !useNativeMedia\(withVideo \|\| call\.video\)/);
});

test("web/Safari: Answer tap binds the mic in the gesture and hands it to the UDP session", () => {
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.match(src, /this\.tapMic = navigator\.mediaDevices\s*\.getUserMedia/);
  assert.match(src, /preTrack: tapMic/);
  const ms = readFileSync(new URL("../../src/lib/calls/mediasoupSession.ts", import.meta.url), "utf8");
  assert.match(ms, /pre && pre\.readyState === "live"\s*\? pre/);
});

test("native media: Android app shim (OpenLoungeNativeMedia) is used; the Java interface alone is not", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  // Android Java bridge: capabilities() is a method returning a JSON string — must not count as native media
  const w = installWindow({ capabilities: () => '["calls","nativeMedia"]', postMessage() {} });
  assert.equal(m.useNativeMedia(false), false, "0.3.15 Android / no shim: WebView path");
  const cmds: unknown[] = [];
  const replies: unknown[] = [];
  w.OpenLoungeNativeMedia = {
    capabilities: ["nativeMedia"],
    nativeMedia: async (c: unknown) => { cmds.push(c); return { attached: false }; },
    msReply: (...a: unknown[]) => { replies.push(a); },
  };
  assert.equal(m.useNativeMedia(false), true, "Android 0.3.16 app: native audio");
  assert.equal(m.useNativeMedia(true), false, "video calls keep the WebView path");
  const sock = fakeSocket();
  const s = new m.NativeMediaSession(sock as never, { provider: "mediasoup", callId: "c1", iceServers: [] } as never, {
    onRemoteTrack() {}, onState() {}, onLocalVideo() {}, callId: "c1",
  });
  await s.connect(false);
  assert.deepEqual(cmds[0], { op: "connect", callId: "c1", iceServers: [], tcpOnly: false });
  await (w.__olNativeMsReq as (id: string, ev: string, d: unknown) => void)("m1", "ms:join", { callId: "c1", nativeConn: "n_x" });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(replies[0], ["m1", true, { ok: true, echo: "ms:join" }]);
  s.close();
});

test("native media: Android 0.3.17 'wants LiveKit' signal hands over now; iOS/web keep the silent first-connect budget", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  installWindow({ capabilities: ["calls", "nativeMedia"], platform: "android", nativeMedia: async () => true, msReply() {} });
  assert.equal(m.nativeMediaIsAndroid(), true);
  const states: string[] = [];
  const wants: string[] = [];
  const s = new m.NativeMediaSession(fakeSocket() as never, { provider: "mediasoup", callId: "c1" } as never, {
    onRemoteTrack() {}, onState: (st) => states.push(st), onLocalVideo() {}, onWantsLiveKit: (r) => wants.push(r),
  });
  await s.connect(false);
  window.dispatchEvent(new CustomEvent("openlounge:native-media", { detail: { state: "failed", fallback: "livekit", reason: "produce: [json.exception.type_error.305]" } }));
  window.dispatchEvent(new CustomEvent("openlounge:native-media", { detail: { state: "failed" } }));
  assert.deepEqual(wants, ["produce: [json.exception.type_error.305]"]);
  assert.deepEqual(states, ["failed"], "a plain failed still maps to state");
  s.close();
  installWindow({ capabilities: ["calls", "nativeMedia"], nativeMedia: async () => true, msReply() {} });
  assert.equal(m.nativeMediaIsAndroid(), false, "iOS bridge has no platform");

  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.ok(src.includes("onWantsLiveKit: (reason) => { if (this.mediasoup === session) void this.nativeLiveKitNow(reason); }"));
  assert.ok(src.includes("if (!recovering && this.mediasoup instanceof NativeMediaSession && nativeMediaIsAndroid()) void this.nativeLiveKitNow("));
  assert.ok(src.includes("else if (!recovering && !this.inFirstRetry) void this.retryFirstConnect("), "web/iOS keep the silent retry budget");
  assert.ok(src.includes('await this.lastResortLiveKit("native-ms-failed", reason);'));
});
