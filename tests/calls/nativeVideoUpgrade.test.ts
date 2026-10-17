import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// minimal browser globals so engine.ts imports under node
const g = globalThis as unknown as Record<string, unknown>;
g.window ??= globalThis;
g.addEventListener ??= () => {};
g.removeEventListener ??= () => {};
g.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.sessionStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
g.document ??= { querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, visibilityState: "visible" };

let CallEngine: typeof import("../../src/lib/calls/engine").CallEngine;
let NativeMediaSession: typeof import("../../src/lib/calls/nativeMediaSession").NativeMediaSession;
let useNativeMedia: typeof import("../../src/lib/calls/nativeMediaSession").useNativeMedia;
let MediasoupCallSession: typeof import("../../src/lib/calls/mediasoupSession").MediasoupCallSession;
test.before(async () => {
  ({ CallEngine } = await import("../../src/lib/calls/engine"));
  ({ NativeMediaSession, useNativeMedia } = await import("../../src/lib/calls/nativeMediaSession"));
  ({ MediasoupCallSession } = await import("../../src/lib/calls/mediasoupSession"));
});

type Fake = Record<string, unknown> & { s: Record<string, unknown>; log: string[] };

function fakeTrack(kind: string, log: string[]) {
  return { kind, stop: () => log.push(`stop:${kind}`) };
}

function setGum(log: string[], fail = false) {
  (globalThis as unknown as { navigator: unknown }).navigator = {
    userAgent: "test",
    mediaDevices: {
      getUserMedia: async (c: { audio: unknown; video: unknown }) => {
        log.push(`gum:video=${!!c.video}`);
        if (fail) throw new Error("NotAllowedError");
        const a = fakeTrack("audio", log), v = fakeTrack("video", log);
        return { getAudioTracks: () => [a], getVideoTracks: () => (c.video ? [v] : []) };
      },
    },
  };
}

function nativeSession(log: string[]) {
  const n = Object.create(NativeMediaSession.prototype);
  n.close = () => log.push("native:close");
  return n;
}

function fakeEngine(log: string[], connectResult: (self: Fake) => unknown): Fake {
  const self: Fake = {
    log,
    s: { call: { id: "c1", video: false }, camOn: false, muted: false, facing: "user" },
    media: { provider: "mediasoup", callId: "c1" },
    busy: true,
    upgrading: null,
    webMedia: false,
    mediasoup: null,
    mediasoupConnected: true,
    roomPromise: null,
    tapMic: null,
    set(p: Record<string, unknown>) { Object.assign(self.s, p); log.push(`set:${Object.keys(p).join(",")}`); },
    netLog(ev: string) { log.push(`log:${ev}`); },
    stopQualityGuard() {}, stopUdpProbe() {}, clearMediasoupDegrade() {},
    req: async (ev: string, d: { on?: boolean }) => { log.push(`req:${ev}:${d.on}`); return { ok: true }; },
    async connect() {
      log.push(`connect:webMedia=${self.webMedia}:camOn=${self.s.camOn}`);
      return connectResult(self);
    },
  };
  Object.defineProperty(self, "upgradeToWebMedia", { value: (CallEngine.prototype as unknown as { upgradeToWebMedia: Function }).upgradeToWebMedia });
  return self;
}

test("useNativeMedia: forceWeb (upgraded call) never picks app-native media", () => {
  (globalThis as unknown as { OpenLoungeNative: unknown }).OpenLoungeNative = { capabilities: ["nativeMedia"], nativeMedia: async () => null, msReply() {} };
  assert.equal(useNativeMedia(false), true);
  assert.equal(useNativeMedia(false, true), false);
  assert.equal(useNativeMedia(true), false);
  delete (globalThis as unknown as { OpenLoungeNative?: unknown }).OpenLoungeNative;
});

test("voice→video on native: capture first, close native BEFORE the web join, web session with camera, call:video on", async () => {
  const log: string[] = [];
  setGum(log);
  const self = fakeEngine(log, (s) => { const w = Object.create(MediasoupCallSession.prototype); s.mediasoup = w; return w; });
  self.mediasoup = nativeSession(log);
  await (CallEngine.prototype.toggleCam as Function).call(self);
  const i = (x: string) => log.findIndex((l) => l.startsWith(x));
  assert.ok(i("gum:video=true") >= 0, "mic+camera captured");
  assert.ok(i("gum:video=true") < i("native:close"), "capture before native teardown (denial leaves the call alone)");
  assert.ok(i("native:close") < i("connect:"), "native closed before the web session joins (no double audio / transport fight)");
  assert.ok(log.includes("connect:webMedia=true:camOn=true"), "web path with camera");
  assert.ok(log.includes("req:call:video:true"), "peer told video is on");
  assert.equal(self.s.camOn, true);
  assert.equal(self.webMedia, true);
  assert.ok(!log.includes("stop:audio"), "the captured mic is handed to the session, not stopped");
  assert.equal(self.s.error, undefined);
});

test("remote side on native receives call:video on → upgrades to the web path without camera (consume video)", async () => {
  const log: string[] = [];
  setGum(log);
  const self = fakeEngine(log, (s) => { const w = Object.create(MediasoupCallSession.prototype); s.mediasoup = w; return w; });
  self.mediasoup = nativeSession(log);
  const onVideo = (CallEngine.prototype as unknown as Record<string, unknown>);
  // onVideo is an instance arrow field: exercise it through a real instance's source contract + the method directly
  const ok = await (self.upgradeToWebMedia as Function).call(self, false);
  assert.equal(ok, true);
  assert.ok(log.includes("gum:video=false"));
  assert.ok(log.includes("connect:webMedia=true:camOn=false"));
  assert.equal(self.s.camOn, false);
  void onVideo;
  const src = readFileSync("src/lib/calls/engine.ts", "utf8");
  assert.match(src, /private onVideo = [\s\S]{0,400}d\.on && this\.mediasoup instanceof NativeMediaSession\) void this\.upgradeToWebMedia\(false\)/);
});

test("upgrade failure (web join fails): back to native audio, camOn off, 'Camera unavailable' shown", async () => {
  const log: string[] = [];
  setGum(log);
  let n = 0;
  const self = fakeEngine(log, (s) => { n++; if (n === 1) { s.mediasoup = { close: () => log.push("web:close") }; return null; } return {}; });
  self.mediasoup = nativeSession(log);
  await (CallEngine.prototype.toggleCam as Function).call(self);
  assert.ok(log.includes("web:close"), "half-built web session closed");
  assert.ok(log.includes("connect:webMedia=false:camOn=false"), "reconnected on native audio");
  assert.ok(log.includes("stop:audio"), "captured mic released");
  assert.equal(self.s.camOn, false);
  assert.equal(self.s.error, "Camera unavailable. Continuing with audio.");
  assert.ok(!log.includes("req:call:video:true"));
});

test("permission denied: native audio untouched (no close, no reconnect), message shown", async () => {
  const log: string[] = [];
  setGum(log, true);
  const self = fakeEngine(log, () => null);
  self.mediasoup = nativeSession(log);
  await (CallEngine.prototype.toggleCam as Function).call(self);
  assert.ok(!log.includes("native:close"));
  assert.ok(!log.some((l) => l.startsWith("connect:")));
  assert.equal(self.s.error, "Camera unavailable. Continuing with audio.");
});

test("upgrade is single-flight and the web flag resets at call end; native throw kept as last-resort fallback", async () => {
  const src = readFileSync("src/lib/calls/engine.ts", "utf8");
  assert.match(src, /if \(this\.upgrading\) return this\.upgrading;/);
  assert.match(src, /this\.media = null;\s*this\.webMedia = false;/);
  assert.match(src, /useNativeMedia\(!!this\.s\.call\?\.video \|\| this\.s\.camOn, this\.webMedia\) \? NativeMediaSession/);
  await assert.rejects(NativeMediaSession.prototype.enableCamera.call({} as never), /audio-only/);
});
