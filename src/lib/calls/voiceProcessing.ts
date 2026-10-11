// Bounded microphone headroom for calls. This runs after the browser's echo cancellation / noise suppression / AGC,
// then applies a gentle compressor so a quiet speaker is clearer without clipping louder speech.

export const CALL_MIC_GAIN = 1.5; // +3.5 dB before the safety compressor
export const CALL_MIC_COMPRESSOR = {
  threshold: -18,
  knee: 14,
  ratio: 3.5,
  attack: 0.003,
  release: 0.16,
} as const;

type VoiceProcessorOptions = { track: MediaStreamTrack; audioContext: AudioContext };

/** The narrow LiveKit surface needed to safely attach and remove a processor. */
export type VoiceProcessingTrack = {
  setAudioContext(context: AudioContext): void;
  setProcessor(processor: CallVoiceProcessor): Promise<unknown>;
  stopProcessor(): Promise<unknown>;
};

export type VoiceProcessingHandle = {
  /** Ensures that a suspended/interrupted context has reverted the published track to the raw microphone. */
  publishRawIfNeeded(): Promise<void>;
  /** Removes the context listener when the call track is discarded. */
  dispose(): void;
};

export const isAudioContextRunning = (context: Pick<AudioContext, "state"> | null | undefined) => context?.state === "running";

/**
 * Attach bounded gain/compression only to a live Web Audio graph. WebKit and older WebViews can create a destination
 * track while its context is suspended; publishing that destination is silent, so the raw browser-captured mic is the
 * safe fallback both before a gesture unlock and after an interruption.
 */
export async function enableVoiceProcessing(track: VoiceProcessingTrack, context: AudioContext | null): Promise<VoiceProcessingHandle | null> {
  if (!context || context.state !== "running") return null;

  let rawMic: Promise<void> | null = null;
  const restoreRawMic = () =>
    (rawMic ??= Promise.resolve(track.stopProcessor())
      .then(() => undefined)
      .catch(() => undefined));

  track.setAudioContext(context);
  if (!isAudioContextRunning(context)) return null;

  try {
    await track.setProcessor(new CallVoiceProcessor());
  } catch (error) {
    await restoreRawMic();
    throw error;
  }
  if (!isAudioContextRunning(context)) {
    await restoreRawMic();
    return null;
  }

  const onStateChange = () => {
    if (!isAudioContextRunning(context)) void restoreRawMic();
  };
  context.addEventListener("statechange", onStateChange);
  return {
    publishRawIfNeeded: async () => {
      if (!isAudioContextRunning(context)) await restoreRawMic();
      if (rawMic) await rawMic;
    },
    dispose: () => context.removeEventListener("statechange", onStateChange),
  };
}

/** LiveKit-compatible processor. If Web Audio is unavailable, the caller keeps the untouched microphone track. */
export class CallVoiceProcessor {
  name = "openlounge-voice-headroom";
  processedTrack?: MediaStreamTrack;
  private nodes: AudioNode[] = [];

  async init({ track, audioContext }: VoiceProcessorOptions) {
    if (!isAudioContextRunning(audioContext)) throw new Error("AudioContext is not running");
    await this.destroy();
    const source = audioContext.createMediaStreamSource(new MediaStream([track]));
    const gain = audioContext.createGain();
    const compressor = audioContext.createDynamicsCompressor();
    const destination = audioContext.createMediaStreamDestination();
    gain.gain.value = CALL_MIC_GAIN;
    compressor.threshold.value = CALL_MIC_COMPRESSOR.threshold;
    compressor.knee.value = CALL_MIC_COMPRESSOR.knee;
    compressor.ratio.value = CALL_MIC_COMPRESSOR.ratio;
    compressor.attack.value = CALL_MIC_COMPRESSOR.attack;
    compressor.release.value = CALL_MIC_COMPRESSOR.release;
    source.connect(gain).connect(compressor).connect(destination);
    const processed = destination.stream.getAudioTracks()[0];
    if (!processed) {
      source.disconnect();
      gain.disconnect();
      compressor.disconnect();
      destination.disconnect();
      throw new Error("Voice processor did not produce an audio track");
    }
    this.nodes = [source, gain, compressor, destination];
    this.processedTrack = processed;
  }

  async restart(opts: VoiceProcessorOptions) {
    await this.init(opts);
  }

  async destroy() {
    const processed = this.processedTrack;
    this.processedTrack = undefined;
    for (const node of this.nodes) {
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.nodes = [];
    processed?.stop();
  }
}
