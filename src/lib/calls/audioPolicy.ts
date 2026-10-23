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
  // Voice at 64 kbps is still tiny next to video; FEC stays on for loss.
  opusDtx: false,
  opusStereo: false,
  opusMaxPlaybackRate: 48_000,
  // 64 kbps mono fullband (Oct 23, clarity): headroom for in-band FEC on lossy links without starving the primary
  // encode. The browser's bandwidth estimator still sets the real rate below this cap on a congested link.
  opusMaxAverageBitrate: 64_000,
  // 20 ms frames: Opus' standard voice packetization, the best balance of header overhead and loss recovery.
  opusPtime: 20,
} as const;

/**
 * Single RTP encoding for the UDP voice producer. Voice is tiny next to video, so it is marked high priority for both
 * the browser's bandwidth allocator and DSCP network priority; it stays independent of every video bitrate cap.
 */
export const MIC_AUDIO_ENCODING = {
  maxBitrate: 64_000,
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
 * Voice floor for the audio ladder, every platform (Oct 23; was Android-only 24 kbps after 85a16932). On loss the
 * ladder used to cut Opus to 16 kbps exactly when FEC needs headroom: random loss on a Kenya–US path is not congestion,
 * and a lower cap does not reduce it — it only made voice muffled. Congestion is still handled: maxBitrate is a cap,
 * and the browser/libwebrtc bandwidth estimator sends less than it whenever the link can't carry it.
 */
export const VOICE_FLOOR_BPS = 32_000;
/** @deprecated kept for older imports; the floor now applies on every platform */
export const ANDROID_VOICE_FLOOR_BPS = VOICE_FLOOR_BPS;
/** Top voice cap (matches opusMaxAverageBitrate / MIC_AUDIO_ENCODING). The shared LADDER (netAdapt.ts, protected) still
 *  lists 48 kbps on its top rung; that rung means "full quality", so it maps to this cap. Offline libopus A/B on the
 *  reference clip (VOIP, FEC, 12 % loss, PESQ-WB): 16k 2.24 / 24k 3.60 / 32k 3.72 / 48k 3.90 / 64k 3.96. */
export const VOICE_TOP_BPS = 64_000;
export function voiceLadderBps(stepBps: number, _ua = ""): number {
  void _ua;
  if (stepBps >= 48_000) return VOICE_TOP_BPS;
  return Math.max(stepBps, VOICE_FLOOR_BPS);
}
