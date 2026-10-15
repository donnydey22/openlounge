// Video-message recording keeps the front-camera mirror strictly in the live self-preview.
// A canvas-backed stream removes device-facing metadata before MediaRecorder encodes it, which
// prevents a WebView/Safari recorder from carrying a front-camera mirror or rotation into the file.

export type VideoMessageFacing = "user" | "environment";

/**
 * Front-camera video messages are saved exactly as the sender saw them in the live selfie preview
 * (horizontally flipped, Telegram-style), so the review, the bubble and the full-screen player match the
 * preview on every client without any playback CSS. Back-camera notes are never flipped.
 */
export const FRONT_CAMERA_VIDEO_MESSAGE_MATCHES_PREVIEW = true;

export function shouldNormalizeVideoMessageRecording(facing: VideoMessageFacing) {
  return facing === "user";
}

export function recordingFrameRate(track: Pick<MediaStreamTrack, "getSettings"> | undefined) {
  const rate = track?.getSettings?.().frameRate;
  return typeof rate === "number" && Number.isFinite(rate) ? Math.min(30, Math.max(1, Math.round(rate))) : 30;
}

export function recordingFrameSize(
  video: Pick<HTMLVideoElement, "videoWidth" | "videoHeight">,
  track?: Pick<MediaStreamTrack, "getSettings">,
) {
  const settings = track?.getSettings?.();
  const width = Math.round(video.videoWidth || settings?.width || 0);
  const height = Math.round(video.videoHeight || settings?.height || 0);
  return width >= 2 && height >= 2 ? { width, height } : null;
}

export type VideoMessageRecording = {
  /** The stream passed to MediaRecorder. This is unmirrored for the front camera. */
  stream: MediaStream;
  /** Stops only the helper's canvas/video resources. The caller still owns the source stream. */
  release: () => void;
  normalized: boolean;
};

type NormalizerEnvironment = {
  createVideo: () => HTMLVideoElement;
  createCanvas: () => HTMLCanvasElement;
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
};

const browserEnvironment = (): NormalizerEnvironment | null => {
  if (typeof document === "undefined" || typeof requestAnimationFrame !== "function" || typeof cancelAnimationFrame !== "function") return null;
  return {
    createVideo: () => document.createElement("video"),
    createCanvas: () => document.createElement("canvas"),
    requestFrame: requestAnimationFrame,
    cancelFrame: cancelAnimationFrame,
  };
};

async function playUnstyledSource(video: HTMLVideoElement) {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        video.removeEventListener("loadeddata", done);
        video.removeEventListener("error", fail);
        resolve();
      };
      const fail = () => {
        video.removeEventListener("loadeddata", done);
        video.removeEventListener("error", fail);
        reject(new Error("Camera frame unavailable"));
      };
      video.addEventListener("loadeddata", done, { once: true });
      video.addEventListener("error", fail, { once: true });
    });
  }
  await video.play();
}

/**
 * Returns a MediaRecorder input stream with raw, unmirrored pixels for the front camera.
 *
 * The visible preview can be mirrored with CSS for the familiar selfie experience. CSS does
 * not alter a MediaStream, so this helper intentionally draws an *unstyled* video element to
 * a canvas and records the canvas track. That detaches historically inconsistent front-camera
 * mirror/orientation metadata in iOS and Android WebViews while preserving the original audio.
 * Any unsupported browser falls back to the source stream rather than preventing a video note.
 */
export async function createVideoMessageRecordingStream(
  source: MediaStream,
  facing: VideoMessageFacing,
  environment: NormalizerEnvironment | null = browserEnvironment(),
): Promise<VideoMessageRecording> {
  if (!shouldNormalizeVideoMessageRecording(facing) || !environment) return { stream: source, release: () => {}, normalized: false };

  const sourceTrack = source.getVideoTracks()[0];
  if (!sourceTrack) return { stream: source, release: () => {}, normalized: false };

  const video = environment.createVideo();
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = source;

  try {
    await playUnstyledSource(video);
    const size = recordingFrameSize(video, sourceTrack);
    if (!size) throw new Error("Camera dimensions unavailable");

    const canvas = environment.createCanvas();
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context || typeof canvas.captureStream !== "function") throw new Error("Canvas recording unavailable");

    // Bake the selfie flip into the pixels so every player (web, iOS WKWebView, Android WebView, and
    // the server poster/HLS transcode) shows what the preview showed. No playback transform is needed.
    if (FRONT_CAMERA_VIDEO_MESSAGE_MATCHES_PREVIEW) context.setTransform(-1, 0, 0, 1, canvas.width, 0);
    const paint = () => context.drawImage(video, 0, 0, canvas.width, canvas.height);
    paint();
    const output = canvas.captureStream(recordingFrameRate(sourceTrack));
    source.getAudioTracks().forEach((track) => output.addTrack(track));

    let frame = 0;
    let released = false;
    const draw = () => {
      if (released) return;
      paint();
      frame = environment.requestFrame(draw);
    };
    frame = environment.requestFrame(draw);

    return {
      stream: output,
      normalized: true,
      release: () => {
        if (released) return;
        released = true;
        environment.cancelFrame(frame);
        output.getVideoTracks().forEach((track) => track.stop());
        video.pause();
        video.srcObject = null;
      },
    };
  } catch {
    video.pause();
    video.srcObject = null;
    return { stream: source, release: () => {}, normalized: false };
  }
}
