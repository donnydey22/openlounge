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
  // DTX off: it clipped word onsets and dropped to comfort noise between phrases, which read as "quiet/cutting out".
  // Voice at 48 kbps is still tiny next to video; FEC stays on for loss.
  opusDtx: false,
  opusStereo: false,
  opusMaxPlaybackRate: 48_000,
  opusMaxAverageBitrate: 48_000,
  // 20 ms frames: Opus' standard voice packetization, the best balance of header overhead and loss recovery.
  opusPtime: 20,
} as const;

/**
 * Single RTP encoding for the UDP voice producer. Voice is tiny next to video, so it is marked high priority for both
 * the browser's bandwidth allocator and DSCP network priority; it stays independent of every video bitrate cap.
 */
export const MIC_AUDIO_ENCODING = {
  maxBitrate: 48_000,
  priority: "high",
  networkPriority: "high",
} as const satisfies RTCRtpEncodingParameters & { networkPriority?: RTCPriorityType };

/** ICE states where the same transport should try fresh ICE credentials before the call drops to the TCP fallback. */
export function shouldRestartIce(state: string): boolean {
  return state === "disconnected" || state === "failed";
}

/** True when the live microphone must be recaptured: the track ended, or its device vanished (unplugged headset). */
export function micNeedsRecovery(
  track: Pick<MediaStreamTrack, "readyState"> & { getSettings?(): { deviceId?: string } } | null | undefined,
  availableAudioInputIds?: readonly string[] | null,
): boolean {
  if (!track) return false;
  if (track.readyState === "ended") return true;
  if (!availableAudioInputIds || availableAudioInputIds.length === 0) return false;
  const id = track.getSettings?.().deviceId;
  if (!id || id === "default" || id === "communications") return false;
  return !availableAudioInputIds.includes(id);
}

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

/**
 * Restart remote call audio that a WebView paused (app backgrounded, autoplay block, iOS audio interruption).
 * Returns whether any element is still blocked so the UI can keep its existing "tap to enable audio" prompt.
 */
export async function resumePausedCallAudio(els: readonly Pick<HTMLMediaElement, "paused" | "play">[]): Promise<boolean> {
  let blocked = false;
  await Promise.all(els.filter((el) => el.paused).map((el) => el.play().catch(() => { blocked = true; })));
  return blocked;
}

/**
 * Voice floor for the audio ladder on Android (85a16932: three loss steps took Keiko's Opus to 16 kbps). 24 kbps is
 * still a normal wideband voice rate and keeps Opus FEC effective; the ladder's upper steps are unchanged.
 */
export const ANDROID_VOICE_FLOOR_BPS = 24_000;
export function voiceLadderBps(stepBps: number, ua = ""): number {
  return /Android/i.test(ua) ? Math.max(stepBps, ANDROID_VOICE_FLOOR_BPS) : stepBps;
}
