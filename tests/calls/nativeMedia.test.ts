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

const setUA = (userAgent: string) => Object.defineProperty(globalThis, "navigator", { value: { userAgent }, configurable: true, writable: true });

test("native media: iOS voice stays native and an explicit paired-video grant is the only video exception", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  installWindow(null);
  assert.equal(m.useNativeMedia(false), false, "Safari / web: never");
  installWindow({ capabilities: ["calls"], nativeMedia: async () => true, msReply() {} });
  assert.equal(m.useNativeMedia(false), false, "older iOS app without the capability");
  installWindow({ capabilities: ["calls", "nativeMedia"], nativeMedia: async () => true, msReply() {} });
  assert.equal(m.useNativeMedia(false), true);
  assert.equal(m.useNativeMedia(true), false, "older binaries keep WebView video");
  installWindow({ capabilities: ["calls", "nativeMedia", "nativeVideo"], nativeMedia: async () => true, msReply() {} });
  assert.equal(m.useNativeMedia(true, { iosNativeVideo: true } as never), true, "only the server grant enables paired native video");
  assert.equal(m.useNativeMedia(true, { iosNativeVideo: false } as never), false);
});

test("native media: page relays the app's ms:* signaling for this call only, forwards consumer availability, maps state", async () => {
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
  const remoteVideo: boolean[] = [];
  const s = new m.NativeMediaSession(sock as never, { provider: "mediasoup", callId: "c1", iceServers: [{ urls: "turn:x" }] } as never, {
    onRemoteTrack() {}, onState: (st) => states.push(st), onRemoteVideo: (on) => remoteVideo.push(on), onLocalVideo() {}, tcpOnly: true,
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
  // Availability only: the native MediaStream remains in App.tsx, while the page selects remote-full/local-PiP.
  window.dispatchEvent(new CustomEvent("openlounge:native-media", { detail: { state: "remote-video", callId: "c1", on: true } }));
  window.dispatchEvent(new CustomEvent("openlounge:native-media", { detail: { state: "remote-video", callId: "other-call", on: false } }));
  window.dispatchEvent(new CustomEvent("openlounge:native-media", { detail: { state: "remote-video", callId: "c1", on: false } }));
  assert.deepEqual(states, ["disconnected", "connected"]);
  assert.deepEqual(remoteVideo, [true, false]);
  await s.setMuted(true);
  assert.ok(cmds.some((c) => c.op === "mute" && c.muted === true));
  const stats = await s.getTransportStats();
  assert.equal((stats[0] as unknown as Map<string, unknown>).size, 1);
  const bridgeSource = readFileSync(new URL("../../src/lib/calls/nativeMediaSession.ts", import.meta.url), "utf8");
  assert.doesNotMatch(bridgeSource, /consumerClosed|ms:consumer:closed/);
  s.close();
  assert.equal(w.__olNativeMsReq, undefined);
  assert.ok(cmds.some((c) => c.op === "close"));
});

test("engine: a granted iPhone video call latches native ownership and permanently fences page capture", () => {
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.match(src, /private iosNativeCall: string \| null = null/);
  assert.match(src, /private iosNativeVideoLatched\(\)/);
  assert.match(src, /this\.iosNativeCall = r\.call\.id/);
  assert.match(src, /prepareNativeMedia\(this\.socket, this\.media/);
  assert.match(src, /if \(this\.iosNativeVideoLatched\(\)\) return null;/);
  assert.doesNotMatch(src, /iosNativeVideoToWebView|iosNativeVideoWebFallbackCall/);
});

test("native iPhone video reuses the existing call overlay above a suppressed app-shell raster", () => {
  const overlay = readFileSync(new URL("../../src/components/calls/CallOverlay.tsx", import.meta.url), "utf8");
  const provider = readFileSync(new URL("../../src/components/calls/CallProvider.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../../src/components/calls/calls.module.css", import.meta.url), "utf8");
  const globals = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
  assert.match(provider, /const nativeFullscreen = s\.nativeVideo && !s\.minimized/);
  assert.match(provider, /s\.ui === "connecting" \|\| s\.ui === "active"/);
  assert.match(provider, /s\.remoteCam \|\| s\.camOn/);
  assert.match(provider, /root\.setAttribute\("data-native-video-screen", ""\)/);
  assert.match(provider, /root\.removeAttribute\("data-native-video-screen"\)/);
  assert.match(provider, /css\.nativeVideoUnderlay/);
  assert.match(overlay, /const nativeFullscreen = s\.nativeVideo && !s\.minimized/);
  assert.match(overlay, /nativeFullscreen && css\.nativeVideoScreen/);
  assert.match(overlay, /const \[swap, setSwap\] = useState\(false\)/);
  assert.match(overlay, /const bigWhich: "local" \| "remote" = s\.remoteCam && s\.camOn \? \(swap \? "local" : "remote"\) : s\.remoteCam \? "remote" : "local"/);
  assert.match(overlay, /big: \{ kind: bigWhich, rect: big, fit: "cover" \}/);
  assert.match(overlay, /const stage = bigTile\.current\?\.getBoundingClientRect\(\)/);
  assert.match(overlay, /const left = Math\.max\(stage\.left, r\.left\)/);
  assert.match(overlay, /window\.addEventListener\("orientationchange", notify\)/);
  assert.match(overlay, /setDrag\(\{ x: Math\.max\(b\.minX, Math\.min\(b\.maxX, x\)\), y: Math\.max\(b\.minY, Math\.min\(b\.maxY, y\)\) \}\)/);
  assert.doesNotMatch(overlay, /createPortal|data-ol-native-video-call/);
  assert.match(styles, /\.nativeVideoUnderlay \{ display: contents; visibility: hidden; pointer-events: none; \}/);
  assert.match(styles, /\.nativeVideoScreen, \.nativeVideoScreen \.videoStage, \.nativeVideoScreen \.pip \{ background: transparent !important; \}/);
  assert.match(globals, /html\[data-native-video-screen\],\s*html\[data-native-video-screen\] body \{\s*background: transparent !important;/);
  assert.match(globals, /html\[data-native-video-screen\] body \{\s*background-image: none !important;\s*transition: none;/);
});

test("native media: only an explicit iPhone video grant adds video fields and the shared msid to the app command", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  const cmds: Record<string, unknown>[] = [];
  installWindow({ capabilities: ["calls", "nativeMedia", "nativeVideo"], nativeMedia: async (c: Record<string, unknown>) => { cmds.push(c); return true; }, msReply() {} });
  const s = new m.NativeMediaSession(fakeSocket() as never, { provider: "mediasoup", callId: "c-native", iceServers: [], iosNativeVideo: true } as never, {
    onRemoteTrack() {}, onState() {}, onLocalVideo() {}, callId: "c-native", streamId: "ol-c-native-u1",
  });
  await s.connect(true);
  assert.deepEqual(cmds[0], { op: "connect", callId: "c-native", iceServers: [], video: true, nativeVideo: true, streamId: "ol-c-native-u1", tcpOnly: false });
  s.close();
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

test("native media: ordinary voice remains audio-only while a latched iPhone video call never forwards a LiveKit grant to the app (LiveKit removed from calling)", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  const cmds: Record<string, unknown>[] = [];
  installWindow({ capabilities: ["calls", "nativeMedia", "nativeVideo"], nativeMedia: async (c: Record<string, unknown>) => { cmds.push(c); return true; }, msReply() {} });
  const s = new m.NativeMediaSession(fakeSocket() as never, { provider: "livekit", url: "wss://lk", token: "t", iceServers: [] } as never, { onRemoteTrack() {}, onState() {}, onLocalVideo() {}, callId: "c9", nativeVideo: true, streamId: "ol-c9-u1" });
  await assert.rejects(s.connect(true), /livekit calling removed/);
  assert.equal(cmds.some((c) => c.op === "connectLiveKit"), false);
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.match(src, /media\.provider === "mediasoup" \|\| this\.iosNativeVideoLatched\(\)/);
  s.close();
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

test("native media: Android keeps its existing WebView fallback while a latched iPhone video call remains native", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  installWindow({ capabilities: ["calls", "nativeMedia"], platform: "android", nativeMedia: async () => true, msReply() {} });
  assert.equal(m.nativeMediaIsAndroid(), true);
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.ok(src.includes("if (nativeMediaIsAndroid()) return this.androidNativeToWebView(reason);"));
  assert.match(src, /if \(this\.iosNativeVideoLatched\(\)\) return this\.lastResortRelay\("native-ms-failed", reason\)/);
  assert.match(src, /if \(this\.iosNativeVideoLatched\(\)\) return void this\.rejoin\("native-relay:failed"\)/);
});

test("Android baseline moat: WebView media by default for every build; native only with the server opt-in, build 34+, and a healthy device; a failure falls back and holds for 7 days", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  const prevNav = (globalThis as { navigator?: unknown }).navigator;
  try {
    m.resetAndroidNativeMedia();
    installWindow({ capabilities: ["calls", "nativeMedia"], platform: "android", nativeMedia: async () => true, msReply() {} });
    setUA("Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile OpenLounge/android/0.3.19(35) OpenLoungeAndroid/0.3.19");
    assert.equal(m.androidAppBuild(), 35);
    assert.equal(m.useNativeMedia(false), false, "0.3.19 (35) with no server opt-in: WebView baseline");
    m.noteAndroidNativeOptIn(false);
    assert.equal(m.useNativeMedia(false), false, "explicit server off: WebView baseline");
    m.noteAndroidNativeOptIn(true);
    assert.equal(m.useNativeMedia(false), true, "server opt-in + build 35: native");
    assert.equal(m.useNativeMedia(true), false, "video calls keep the WebView path");
    setUA("Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile OpenLounge/android/0.3.17(33) OpenLoungeAndroid/0.3.17");
    assert.equal(m.useNativeMedia(false), false, "build 33 stays on WebView even when opted in");
    setUA("Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile OpenLounge/android/0.3.19(35) OpenLoungeAndroid/0.3.19");
    m.disableAndroidNativeMedia("first connect budget");
    assert.equal(m.useNativeMedia(false), false, "after a native failure: WebView path");
    assert.equal(m.androidNativeDisabledReason(), "first connect budget");
    m.newAndroidPageSession();
    assert.equal(m.useNativeMedia(false), false, "device guard holds across page reloads");
    assert.equal(m.androidNativeHealthy(Date.now() + m.ANDROID_NATIVE_COOLDOWN_MS + 1000), true, "guard expires after 7 days");
    m.noteAndroidNativeOptIn(false);
    assert.equal(m.androidNativeOptedIn(), false, "server kill switch clears the opt-in on the next grant");
    installWindow({ capabilities: ["calls", "nativeMedia"], nativeMedia: async () => true, msReply() {} });
    assert.equal(m.useNativeMedia(false), true, "iOS is never affected by the Android switch");
    installWindow(null);
    assert.equal(m.useNativeMedia(false), false, "web unchanged");
  } finally {
    m.resetAndroidNativeMedia();
    Object.defineProperty(globalThis, "navigator", { value: prevNav, configurable: true, writable: true });
  }
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.ok(/set media\(m: CallMedia \| null\) \{[\s\S]{0,120}noteAndroidNativeOptIn\(!!m\.androidNative\)/.test(src), "every mediasoup grant refreshes the opt-in");
  const fb = src.slice(src.indexOf("private async androidNativeToWebView"), src.indexOf("private lifecycle:"));
  assert.ok(/disableAndroidNativeMedia\(reason\)[\s\S]*dropMediaForRejoin\(\)[\s\S]*this\.msEverConnected = null[\s\S]*await this\.connectMediasoup\(media, true\)/.test(fb), "same call reconnects over WebView media");
  assert.ok(fb.includes("this.nativeWebCall === callId"), "once per call");
});

test("server: CALL_ANDROID_NATIVE defaults OFF; only 'on' adds androidNative to mediasoup grants; LiveKit grants never carry it", async () => {
  const { androidNativeEnabled } = await import("../../server/calls/sfuSelect");
  assert.equal(androidNativeEnabled({}), false);
  assert.equal(androidNativeEnabled({ CALL_ANDROID_NATIVE: "off" }), false);
  assert.equal(androidNativeEnabled({ CALL_ANDROID_NATIVE: "true" }), false);
  assert.equal(androidNativeEnabled({ CALL_ANDROID_NATIVE: "on" }), true);
  const idx = readFileSync(new URL("../../server/calls/index.ts", import.meta.url), "utf8");
  assert.ok(idx.includes("...(androidNativeEnabled() ? { androidNative: true } : {})"));
  assert.equal((idx.match(/androidNative: true/g) ?? []).length, 1, "only the mediasoup grant");
});

test("CALL_IOS_NATIVE_VIDEO=off leaves Android native-audio opt-in and Android-to-Android video on their existing paths", async () => {
  const { iosNativeVideoEnabled } = await import("../../server/calls/sfuSelect");
  assert.equal(iosNativeVideoEnabled({ CALL_IOS_NATIVE_VIDEO: "off" }), false);
  const m = await import("../../src/lib/calls/nativeMediaSession");
  const prevNav = (globalThis as { navigator?: unknown }).navigator;
  try {
    m.resetAndroidNativeMedia();
    installWindow({ capabilities: ["calls", "nativeMedia"], platform: "android", nativeMedia: async () => true, msReply() {} });
    setUA("Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile OpenLounge/android/0.3.19(35) OpenLoungeAndroid/0.3.19");
    m.noteAndroidNativeOptIn(true);
    assert.equal(m.useNativeMedia(false), true, "Android native audio remains controlled solely by its own opt-in");
    assert.equal(m.useNativeMedia(true), false, "Android-to-Android video remains on the frozen WebView path");
  } finally {
    m.resetAndroidNativeMedia();
    Object.defineProperty(globalThis, "navigator", { value: prevNav, configurable: true, writable: true });
  }
});

test("baseline regression (a8a754e): Android WebView path keeps the 5 s first-connect budget from answer, mic handling, LiveKit pin", () => {
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.ok(src.includes("static FIRST_CONNECT_BUDGET_MS = 5_000;"));
  assert.ok(src.includes("Promise.race([session.connect(this.s.camOn), this.firstConnectBudget()])"));
  assert.ok(/while \(ringing\(\)\) await[\s\S]{0,80}this\.firstConnectT0 = Date\.now\(\)/.test(src));
  assert.ok(/: CallEngine\.FIRST_CONNECT_BUDGET_MS;/.test(src), "WebView session gets the unchanged 5 s base");
  assert.ok(src.includes("} else this.preMic = this.acquireMic();"), "WebView caller still captures the mic at dial (unchanged)");
});

test("Android app: WebView media path, caller budget from answer, LiveKit pinned; iOS native unchanged", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  installWindow({ capabilities: ["calls", "nativeMedia"], platform: "android", nativeMedia: async () => true, msReply() {} });
  assert.equal(m.useNativeMedia(false), false, "Android app without a 0.3.18+ UA uses the WebView path");
  installWindow({ capabilities: ["calls", "nativeMedia"], nativeMedia: async () => true, msReply() {} });
  assert.equal(m.useNativeMedia(false), true, "iOS app keeps native media");
  installWindow(null);
  assert.equal(m.useNativeMedia(false), false, "web unchanged");
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.ok(src.includes("Promise.race([session.connect(this.s.camOn), this.firstConnectBudget()])"));
  assert.ok(/while \(ringing\(\)\) await[\s\S]{0,80}this\.firstConnectT0 = Date\.now\(\)/.test(src), "caller budget starts at answer");
  assert.ok(!/shouldTryUdp\(now\)\) void this\.requestUdpRestore\(\)/.test(src), "no LiveKit → SFU flap-back");
});

test("d8d7eded: push-woken/resumed callee gets a 12 s first-connect grace from socket-back; native LiveKit last resort has its own 15 s budget", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.ok(src.includes("static WOKEN_GRACE_MS = 12_000;"));
  assert.ok(src.includes("static LIVEKIT_JOIN_BUDGET_MS = 15_000;"));
  assert.ok(src.includes('this.s.role !== "callee"'));
  assert.ok(src.includes("this.socketUpAt = Date.now();"));
  assert.ok(src.includes('media.provider === "livekit"\n        ? Promise.race'));
  assert.ok(src.includes('this.failUdpUnreachable("livekit-native"'));
  // the plain 5 s budget remains the default (web caller, non-woken callee)
  assert.ok(src.includes(": CallEngine.FIRST_CONNECT_BUDGET_MS;"));
  assert.ok(src.includes("return base;"));
});

test("3ae8ff34: floor 'tcp' verdict while the transport is still connected resumes the ladder instead of freezing at 16 kbps", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  assert.ok(src.includes("void this.requestTcpFallback().finally(() => {"));
  assert.ok(src.includes("this.mediasoupConnected && !this.msRecovering && this.busy && !this.qualityTimer"));
  const { NetLadder, ADAPT, LADDER } = await import("../../src/lib/calls/netAdapt");
  const l = new NetLadder();
  l.reset(ADAPT.reconnectLevel);
  let up = 0;
  for (let i = 0; i < ADAPT.upAfter; i++) { const a = l.push({ lossPercent: 0, rttMs: 60, outKbps: 300, reasons: [] }); if (a.type === "step" && a.dir === "up") up++; }
  assert.equal(up, 1);
  assert.equal(LADDER[l.level].audioBps, 48_000);
});

// sha256 of `git diff 087c96b -- src/lib/calls/mediasoupSession.ts` (index line stripped) = the FX-044 patch plus the
// every-drop fast ICE restart with backoff (IceRestartBackoff), approved by Donny Oct 24 2026 5:41 AM MST.
// Previous approved hash (FX-044 only): ccf21d2d8fe521cae9f78de3c56ed5b613d017a894706294f1c3fd8253a402d0
// FX-079 (branch harden/dropped-conn-antifreeze-1024): fps floor + maintain-framerate + antiFreeze() added to
// mediasoupSession.ts — approved by Donny Oct 24 2026 8:35 PM MST (previous hash 13bbae17…8c4c).
const MS_SESSION_APPROVED_DIFF_SHA256 = "ce6c6d9a13ccf2522296aff17bbbf0d29bab174478713811d5f041ab034dbdb1";

test("protected: Android video path unchanged — video never takes native media in any opt-in/guard state; WebView video files identical to prod 087c96b", async () => {
  const m = await import("../../src/lib/calls/nativeMediaSession");
  const prevNav = (globalThis as { navigator?: unknown }).navigator;
  try {
    m.resetAndroidNativeMedia();
    installWindow({ capabilities: ["calls", "nativeMedia"], platform: "android", nativeMedia: async () => true, msReply() {} });
    Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (Linux; Android 14) OpenLounge/android/0.3.19(35)" }, configurable: true, writable: true });
    for (const opt of [false, true]) {
      m.noteAndroidNativeOptIn(opt);
      assert.equal(m.useNativeMedia(true), false, `video, opt-in=${opt}`);
    }
    m.disableAndroidNativeMedia("x");
    assert.equal(m.useNativeMedia(true), false, "video after a native failure");
  } finally {
    m.resetAndroidNativeMedia();
    Object.defineProperty(globalThis, "navigator", { value: prevNav, configurable: true, writable: true });
  }
  const { execSync } = await import("node:child_process");
  const changed = execSync("git diff --name-only 087c96b -- src/lib/calls/androidLifecycle.ts", { encoding: "utf8" }).trim();
  assert.equal(changed, "", "Android lifecycle untouched");
  // netAdapt.ts: the ONLY approved change since prod 087c96b is FX-075 (additive videoBpsRecovering; call 30dc469c;
  // Donny approved Oct 24 2026 7:14 PM MST). Any other edit still fails: the diff must equal exactly that patch.
  const { createHash: h75 } = await import("node:crypto");
  const naDiff = execSync("git diff 087c96b -- src/lib/calls/netAdapt.ts", { encoding: "utf8" }).replace(/^index .*\n/m, "");
  assert.equal(h75("sha256").update(naDiff).digest("hex"), "6d267d1e22e43d2f350040c49e7e16836ea0b75cbec942c524f52a18261638d2", "bandwidth ladder: only the approved FX-075 change");
  // mediasoupSession.ts: the ONLY approved change since prod 087c96b is FX-044 (sessionGone + real restartIce result;
  // Donny approved Oct 23 2026 4:48 PM MST). Any other edit still fails: the diff must equal exactly that patch.
  const { createHash } = await import("node:crypto");
  const msDiff = execSync("git diff 087c96b -- src/lib/calls/mediasoupSession.ts", { encoding: "utf8" }).replace(/^index .*\n/m, "");
  assert.equal(createHash("sha256").update(msDiff).digest("hex"), MS_SESSION_APPROVED_DIFF_SHA256, "WebView media session: only the approved FX-044 change");
});


test("iPhone paired-video path: one explicit msid, native prepare, relay-only rebuild, and no WebView escape", () => {
  const src = readFileSync(new URL("../../src/lib/calls/engine.ts", import.meta.url), "utf8");
  const bridge = readFileSync(new URL("../../src/lib/calls/nativeMediaSession.ts", import.meta.url), "utf8");
  assert.match(bridge, /export async function prepareNativeMedia/);
  assert.match(bridge, /nativeVideo \? \{ video: true, nativeVideo: true/);
  assert.match(bridge, /relayOnly/);
  assert.match(src, /this\.iosNativeVideoLatched\(\) && attempt >= 2/);
  assert.match(src, /if \(this\.iosNativeVideoLatched\(\)\) return null;/);
  assert.doesNotMatch(src, /iosNativeVideoToWebView|iosNativeVideoWebFallbackCall/);
  assert.match(bridge, /onRemoteVideo\?\(on: boolean\): void/);
  assert.match(bridge, /s === "remote-video"\) \{[\s\S]{0,320}d\.callId === callId[\s\S]{0,160}onRemoteVideo\?\.\(d\.on === true\)/);
  assert.match(src, /onRemoteVideo: \(on\) => \{[\s\S]{0,160}remoteCam: on/);
});
