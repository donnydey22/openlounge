export type CameraFacing = "user" | "environment";

type VideoStreamLike = {
  getVideoTracks(): MediaStreamTrack[];
  getTracks(): MediaStreamTrack[];
};

export type CameraTrackLike = {
  mediaStreamTrack: MediaStreamTrack;
  replaceTrack(track: MediaStreamTrack, userProvidedTrack?: boolean): Promise<unknown>;
};

export type CameraCapture = (constraints: MediaStreamConstraints) => Promise<VideoStreamLike>;

/**
 * Open the requested camera before touching the active sender. LiveKit's restartTrack() stops the old capture before
 * acquiring the next one, which can leave iOS/Android callers with a black self-view if the switch is denied or the
 * requested lens is unavailable.
 */
export async function captureCameraForFlip(facing: CameraFacing, capture: CameraCapture = (constraints) => navigator.mediaDevices.getUserMedia(constraints)) {
  const stream = await capture({ audio: false, video: { facingMode: facing } });
  const track = stream.getVideoTracks()[0];
  if (track) return track;
  for (const candidate of stream.getTracks()) candidate.stop();
  throw new Error("Camera unavailable");
}

/**
 * Swap only after the target camera is available. If the sender rejects the replacement, reattach the original source
 * before reporting failure so the caller keeps both their self-preview and the existing remote video feed.
 */
export async function replaceCameraForFlip(track: CameraTrackLike, facing: CameraFacing, capture?: CameraCapture) {
  const previous = track.mediaStreamTrack;
  const next = await captureCameraForFlip(facing, capture);
  try {
    await track.replaceTrack(next, false);
    return next;
  } catch (error) {
    next.stop();
    // LocalVideoTrack retains the old source until a replace succeeds. This best-effort restoration also reattaches
    // the preview if the first replace detached it before a mobile sender rejected the new camera.
    await track.replaceTrack(previous, false).catch(() => {});
    throw error;
  }
}
