import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createVideoMessageRecordingStream,
  recordingFrameRate,
  recordingFrameSize,
  shouldNormalizeVideoMessageRecording,
} from "../../src/lib/media/videoOrientation";

test("front-camera video notes are saved flipped to match the selfie preview while back-camera notes stay raw", async () => {
  const sourceTrack = { getSettings: () => ({ width: 640, height: 480, frameRate: 29.7 }) } as unknown as MediaStreamTrack;
  const audioTrack = {} as MediaStreamTrack;
  const source = {
    getVideoTracks: () => [sourceTrack],
    getAudioTracks: () => [audioTrack],
  } as unknown as MediaStream;

  let drawCount = 0;
  const transforms: number[][] = [];
  let played = 0;
  let paused = 0;
  let cancelled = -1;
  let requested: FrameRequestCallback | null = null;
  let capturedRate = 0;
  let outputStopped = 0;
  const added: MediaStreamTrack[] = [];
  const outputTrack = { stop: () => outputStopped++ } as unknown as MediaStreamTrack;
  const output = {
    addTrack: (track: MediaStreamTrack) => added.push(track),
    getVideoTracks: () => [outputTrack],
  } as unknown as MediaStream;
  const video = {
    autoplay: false,
    muted: false,
    playsInline: false,
    srcObject: null,
    readyState: 2,
    videoWidth: 640,
    videoHeight: 480,
    play: async () => void played++,
    pause: () => void paused++,
  } as unknown as HTMLVideoElement;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: () => drawCount++, setTransform: (...m: number[]) => transforms.push(m) }),
    captureStream: (rate: number) => {
      capturedRate = rate;
      return output;
    },
  } as unknown as HTMLCanvasElement;
  const originalMediaElement = globalThis.HTMLMediaElement;
  Object.defineProperty(globalThis, "HTMLMediaElement", { configurable: true, value: { HAVE_CURRENT_DATA: 2 } });
  try {
    const normalized = await createVideoMessageRecordingStream(source, "user", {
      createVideo: () => video,
      createCanvas: () => canvas,
      requestFrame: (callback) => {
        requested = callback;
        return 19;
      },
      cancelFrame: (handle) => {
        cancelled = handle;
      },
    });

    assert.equal(normalized.normalized, true);
    assert.equal(normalized.stream, output, "the recorder receives the canvas stream, not the front camera track");
    assert.equal(video.muted, true);
    assert.equal(video.playsInline, true);
    assert.equal(video.srcObject, source);
    assert.equal(played, 1);
    assert.deepEqual({ width: canvas.width, height: canvas.height }, { width: 640, height: 480 });
    assert.equal(capturedRate, 30, "frame rate is capped to the video-note maximum");
    assert.deepEqual(added, [audioTrack], "the camera microphone remains in the normalized recording");
    assert.equal(drawCount, 1, "first unstyled camera frame is painted before recording starts");
    (requested as unknown as FrameRequestCallback)(0);
    assert.equal(drawCount, 2, "subsequent frames keep painting through the same transform");
    assert.deepEqual(transforms, [[-1, 0, 0, 1, 640, 0]], "front camera pixels are flipped once, matching the live preview");

    normalized.release();
    assert.equal(cancelled, 19);
    assert.equal(outputStopped, 1);
    assert.equal(paused, 1);
    assert.equal(video.srcObject, null);

    const raw = await createVideoMessageRecordingStream(source, "environment", null);
    assert.equal(raw.normalized, false);
    assert.equal(raw.stream, source, "back-camera capture is preserved without needless re-encoding");
  } finally {
    Object.defineProperty(globalThis, "HTMLMediaElement", { configurable: true, value: originalMediaElement });
  }
});

test("video-message orientation helpers keep capture geometry upright and select normalization only for the user camera", () => {
  assert.equal(shouldNormalizeVideoMessageRecording("user"), true);
  assert.equal(shouldNormalizeVideoMessageRecording("environment"), false);
  const track = { getSettings: () => ({ width: 720, height: 1280, frameRate: 120 }) } as unknown as MediaStreamTrack;
  assert.deepEqual(recordingFrameSize({ videoWidth: 0, videoHeight: 0 } as HTMLVideoElement, track), { width: 720, height: 1280 });
  assert.equal(recordingFrameRate(track), 30);
  assert.equal(recordingFrameRate(undefined), 30);
});
