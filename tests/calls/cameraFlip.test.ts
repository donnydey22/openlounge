import test from "node:test";
import assert from "node:assert/strict";
import { captureCameraForFlip, flipCameraTrack, replaceCameraForFlip } from "../../src/lib/calls/cameraFlip";
import { MediasoupCallSession } from "../../src/lib/calls/mediasoupSession";

type Track = MediaStreamTrack & { stopped: number };
const videoTrack = (id: string) => {
  const track = {} as Track;
  Object.assign(track, {
    id,
    kind: "video",
    stopped: 0,
    stop: () => {
      track.stopped++;
    },
  });
  return track;
};

test("camera flip acquires the requested lens before replacing the active source", async () => {
  const old = videoTrack("front");
  const next = videoTrack("back");
  const calls: unknown[] = [];
  const current = {
    mediaStreamTrack: old,
    async replaceTrack(track: MediaStreamTrack, userProvidedTrack?: boolean) {
      calls.push([track, userProvidedTrack]);
    },
  };
  const result = await replaceCameraForFlip(current, "environment", async (constraints) => {
    assert.deepEqual(constraints, {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        aspectRatio: { ideal: 16 / 9 },
        frameRate: { ideal: 30, max: 30 },
      },
    });
    assert.equal(old.stopped, 0, "the active front camera remains live while the back camera is acquired");
    return { getVideoTracks: () => [next], getTracks: () => [next] };
  });
  assert.equal(result, next);
  assert.deepEqual(calls, [[next, false]]);
  assert.equal(old.stopped, 0, "the helper never stops the prior source before a successful swap");
});

test("camera flip acquisition failure preserves the active source", async () => {
  const old = videoTrack("front");
  let replaced = false;
  await assert.rejects(
    replaceCameraForFlip(
      {
        mediaStreamTrack: old,
        async replaceTrack() {
          replaced = true;
        },
      },
      "environment",
      async () => {
        throw new DOMException("No rear camera", "OverconstrainedError");
      },
    ),
    /No rear camera/,
  );
  assert.equal(replaced, false);
  assert.equal(old.stopped, 0);
});

test("a failed sender replacement stops the new capture and restores the old source", async () => {
  const old = videoTrack("front");
  const next = videoTrack("back");
  const replacements: MediaStreamTrack[] = [];
  let calls = 0;
  const current = {
    mediaStreamTrack: old,
    async replaceTrack(track: MediaStreamTrack) {
      replacements.push(track);
      if (calls++ === 0) throw new Error("sender rejected switch");
    },
  };
  await assert.rejects(
    replaceCameraForFlip(current, "environment", async () => ({ getVideoTracks: () => [next], getTracks: () => [next] })),
    /sender rejected switch/,
  );
  assert.equal(next.stopped, 1, "the unused back-camera capture is released");
  assert.deepEqual(replacements, [next, old], "the old camera is restored after replacement failure");
});

test("missing video tracks are released and rejected", async () => {
  const audio = videoTrack("unexpected");
  await assert.rejects(
    captureCameraForFlip("user", async () => ({ getVideoTracks: () => [], getTracks: () => [audio] })),
    /Camera unavailable/,
  );
  assert.equal(audio.stopped, 1);
});

test("Mediasoup flip keeps the current camera when its producer rejects the replacement", async () => {
  const old = videoTrack("front");
  const next = videoTrack("back");
  const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => ({ getVideoTracks: () => [next], getTracks: () => [next] }) } },
  });
  try {
    const session = new MediasoupCallSession({ on() {}, off() {}, request: async () => ({ ok: true }) } as any, { provider: "mediasoup", url: "broker", token: "t", callId: "call" } as any, {
      onRemoteTrack() {},
      onState() {},
      onLocalVideo() {},
    });
    const internal = session as any;
    internal.camera = old;
    internal.producers.set("video", { replaceTrack: async () => { throw new Error("producer rejected switch"); } });
    await assert.rejects(session.flipCamera("environment"), /producer rejected switch/);
    assert.equal(internal.camera, old, "the current local camera is not cleared on a failed flip");
    assert.equal(old.stopped, 0, "the caller keeps their existing self-view");
    assert.equal(next.stopped, 1, "the failed replacement capture is released");
  } finally {
    if (priorNavigator) Object.defineProperty(globalThis, "navigator", priorNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("Mediasoup camera enable and flip use the shared orientation-aware capture policy", async () => {
  const front = videoTrack("front");
  const back = videoTrack("back");
  const seen: MediaStreamConstraints[] = [];
  const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          seen.push(constraints);
          const next = seen.length === 1 ? front : back;
          return { getVideoTracks: () => [next], getTracks: () => [next] };
        },
      },
    },
  });
  try {
    const session = new MediasoupCallSession({ on() {}, off() {}, request: async () => ({ ok: true }) } as any, { provider: "mediasoup", url: "broker", token: "t", callId: "call" } as any, {
      onRemoteTrack() {},
      onState() {},
      onLocalVideo() {},
    });
    const internal = session as any;
    internal.send = {
      produce: async () => ({ close() {}, replaceTrack: async () => {} }),
    };
    await session.enableCamera("user");
    await session.flipCamera("environment");
    assert.deepEqual(seen, [
      {
        video: {
          facingMode: { ideal: "user" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          aspectRatio: { ideal: 16 / 9 },
          frameRate: { ideal: 30, max: 30 },
        },
      },
      {
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          aspectRatio: { ideal: 16 / 9 },
          frameRate: { ideal: 30, max: 30 },
        },
      },
    ]);
    assert.equal(front.stopped, 1, "the replaced first capture is released after a successful flip");
  } finally {
    if (priorNavigator) Object.defineProperty(globalThis, "navigator", priorNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

const lkLike = (old: Track, published: boolean) => {
  const calls: string[] = [];
  const t = {
    mediaStreamTrack: old as MediaStreamTrack,
    sender: published ? {} : undefined,
    async replaceTrack(track: MediaStreamTrack) {
      // mirrors livekit-client LocalTrack.replaceTrack
      if (!t.sender) throw new Error("unable to replace an unpublished track");
      calls.push("replace");
      t.mediaStreamTrack = track;
    },
    async restartTrack(opts: { facingMode: string }) {
      calls.push(`restart:${opts.facingMode}`);
    },
  };
  return { t, calls };
};

test("flip while ringing (unpublished preview) restarts instead of replacing", async () => {
  const { t, calls } = lkLike(videoTrack("front"), false);
  let captured = false;
  await flipCameraTrack(t, "environment", async () => {
    captured = true;
    throw new Error("should not capture");
  });
  assert.deepEqual(calls, ["restart:environment"]);
  assert.equal(captured, false, "no second camera opened for an unpublished preview");
});

test("flip after publish pre-acquires and replaces", async () => {
  const old = videoTrack("front");
  const next = videoTrack("back");
  const { t, calls } = lkLike(old, true);
  const r = await flipCameraTrack(t, "environment", async () => ({ getVideoTracks: () => [next], getTracks: () => [next] }));
  assert.equal(r, next);
  assert.deepEqual(calls, ["replace"]);
  assert.equal(old.stopped, 0);
});
