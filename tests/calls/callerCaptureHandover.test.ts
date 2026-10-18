import { test, mock } from "node:test";
import assert from "node:assert/strict";

class FakeTrack extends EventTarget {
  readyState: "live" | "ended" = "live";
  constructor(public kind: string, public muted = false, public facing = "user") { super(); }
  stop() { this.readyState = "ended"; }
  getSettings() { return { facingMode: this.facing, deviceId: "d" }; }
  applyConstraints() { return Promise.resolve(); }
  set contentHint(_v: string) {}
}

function setup(next: () => FakeTrack[]) {
  const calls: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "iPhone",
      mediaDevices: {
        getUserMedia: async (c: MediaStreamConstraints) => {
          calls.push(c.video ? "video" : "audio");
          const tracks = next();
          return { getVideoTracks: () => tracks.filter((t) => t.kind === "video"), getAudioTracks: () => tracks.filter((t) => t.kind === "audio"), getTracks: () => tracks };
        },
        addEventListener() {}, removeEventListener() {}, enumerateDevices: async () => [],
      },
    },
  });
  return calls;
}

test("iOS caller: a camera muted by the CallKit handover is recaptured onto the existing producer (bounded)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const queue = [new FakeTrack("video", true), new FakeTrack("video", false)];
    const calls = setup(() => [queue.shift() ?? new FakeTrack("video")]);
    const { MediasoupCallSession } = await import("../../src/lib/calls/mediasoupSession");
    const locals: unknown[] = [];
    const s = new MediasoupCallSession({} as never, { provider: "mediasoup" } as never, {
      onRemoteTrack() {}, onState() {}, onLocalVideo: (t) => locals.push(t),
    });
    const replaced: unknown[] = [];
    const cam = new FakeTrack("video", false);
    const anyS = s as unknown as Record<string, unknown> & { producers: Map<string, unknown> };
    anyS.producers.set("video", { replaceTrack: async ({ track }: { track: unknown }) => void replaced.push(track) });
    anyS.camera = cam;
    (s as unknown as { watchCamera(t: unknown): void }).watchCamera(cam);
    cam.muted = true;
    cam.dispatchEvent(new Event("mute"));
    mock.timers.tick(1_200);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 1, "first recapture");
    // first recapture arrived already muted (still mid-handover): no new mute event fires, so it must retry on its own
    mock.timers.tick(1_200);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 2, "retry for an already-muted recapture");
    assert.equal(replaced.length, 2);
    assert.equal(cam.readyState, "ended");
    assert.equal((replaced[1] as FakeTrack).muted, false);
    assert.equal(locals.at(-1), replaced[1]);
    mock.timers.tick(10_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 2, "healthy capture stops retrying");
  } finally {
    mock.timers.reset();
  }
});

test("caller handover checks the camera too (rebindMic / checkMicAlive)", async () => {
  const { readFileSync } = await import("node:fs");
  const ms = readFileSync(new URL("../../src/lib/calls/mediasoupSession.ts", import.meta.url), "utf8");
  assert.match(ms, /rebindMic\(\) \{[\s\S]{0,700}this\.checkCameraAlive\(\)/);
  assert.match(ms, /checkMicAlive\(\) \{[\s\S]{0,200}this\.checkCameraAlive\(\)/);
  assert.match(ms, /next\.addEventListener\("mute", this\.onMicMuted\);\s*if \(next\.muted\) this\.onMicMuted\(\)/);
});
