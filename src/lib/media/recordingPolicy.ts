// Capture requests for chat voice and video messages. Every device quality knob is ideal-only so older Android WebViews
// and iOS WKWebView can continue recording when a camera or microphone cannot meet the preferred configuration.
export const CHAT_AUDIO_CAPTURE_CONSTRAINTS = {
  echoCancellation: { ideal: true },
  noiseSuppression: { ideal: true },
  autoGainControl: { ideal: true },
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 48_000 },
} as const satisfies MediaTrackConstraints;

// Opus/WebM voice notes receive a fuller 64 kbps target (Safari uses its supported AAC/MP4 alternative), then the
// server normalizes delivery formats. Mono voice limits upload size without discarding speech clarity.
export const VOICE_NOTE_AUDIO_BITS_PER_SECOND = 64_000;

export const VIDEO_NOTE_CAPTURE_CONSTRAINTS = {
  width: { ideal: 720 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
} as const satisfies MediaTrackConstraints;

// A 720-square note at 1.5 Mbps remains modest for a one-minute chat clip while retaining more face detail than the
// previous 640-square/1 Mbps request. Audio retains full-band speech headroom alongside the video stream.
export const VIDEO_NOTE_VIDEO_BITS_PER_SECOND = 1_500_000;
export const VIDEO_NOTE_AUDIO_BITS_PER_SECOND = 64_000;
