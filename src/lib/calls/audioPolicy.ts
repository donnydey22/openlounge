// Shared voice-capture policy for both the durable LiveKit path and the UDP Mediasoup path.
// Every constraint is an `ideal`, never an exact requirement: older Android WebViews and iOS WKWebView can keep a
// working microphone when a device cannot expose a particular capability.
export const CALL_AUDIO_CONSTRAINTS = {
  echoCancellation: { ideal: true },
  noiseSuppression: { ideal: true },
  autoGainControl: { ideal: true },
  // Voice calls are mono. Requesting (not requiring) 48 kHz mono avoids an unnecessary stereo encode and gives Opus
  // its normal full-band clock where the hardware/browser supports it.
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 48_000 },
} as const satisfies MediaTrackConstraints;

/**
 * Mediasoup maps these to Opus fmtp values in its SDP. LiveKit owns its negotiated SDP, where `micPublishOptions()`
 * already enables DTX + RED; this makes the UDP-first path equally explicit about loss recovery and silence savings.
 */
export const OPUS_VOICE_CODEC_OPTIONS = {
  opusFec: true,
  opusDtx: true,
  opusStereo: false,
  opusMaxPlaybackRate: 48_000,
  opusMaxAverageBitrate: 48_000,
} as const;

export interface DirectAudioEnvironment {
  ua?: string | null;
  nativePlatform?: "ios" | "android" | null;
}

/**
 * A direct SFU call must never depend on a MediaStreamAudioDestinationNode on phones. iOS/WKWebView can report a
 * running AudioContext after a call/interrupt while that destination no longer produces samples; Android receivers
 * then hear silence. The browser's raw microphone still has AEC, noise suppression and AGC from
 * CALL_AUDIO_CONSTRAINTS, and is the durable native transport source.
 */
export function useRawDirectCallMicrophone(env: DirectAudioEnvironment = {}): boolean {
  if (env.nativePlatform === "ios" || env.nativePlatform === "android") return true;
  return /iPhone|iPad|iPod|Android|Mobi/i.test(env.ua ?? "");
}
