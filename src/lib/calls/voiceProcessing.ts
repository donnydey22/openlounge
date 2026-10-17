// Bounded microphone headroom for calls. This runs after the browser's echo cancellation / noise suppression / AGC,
// then applies a gentle compressor so a quiet speaker is clearer without clipping louder speech.

export const CALL_MIC_GAIN = 2.0; // +6 dB before the safety compressor (was 1.5 / +3.5 dB: "not loud enough")
export const CALL_MIC_COMPRESSOR = {
  threshold: -20,
  knee: 12,
  ratio: 4,
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
  /** Waits for any pending swap so a suspended/interrupted context has reverted the track to the raw microphone. */
  publishRawIfNeeded(): Promise<void>;
  /** True while the published track is the boosted Web Audio destination. */
  readonly processing: boolean;
  /** Removes the context listener when the call track is discarded. */
  dispose(): void;
};

export const isAudioContextRunning = (context: Pick<AudioContext, "state"> | null | undefined) => context?.state === "running";

/**
 * Attach bounded gain/compression only to a live Web Audio graph. WebKit and older WebViews (iOS 15, Android 7) can
 * create a destination track while its context is suspended; publishing that destination is silent. So the raw
 * browser-captured mic is published until the gesture unlock leaves the context "running", the boost is swapped in
 * then (LiveKit replaces the sender track in place — no renegotiation, no gap), and any later suspend/interrupt swaps
 * straight back to the raw mic until the context runs again. Swaps are serialized so a flapping state never races.
 */
export async function enableVoiceProcessing(track: VoiceProcessingTrack, context: AudioContext | null): Promise<VoiceProcessingHandle | null> {
  if (!context) return null;
  let bound = false;
  let processing = false;
  let disposed = false;
  let failed: unknown = null;
  let chain: Promise<void> = Promise.resolve();

  const sync = () => {
    chain = chain.then(async () => {
      const want = !disposed && failed === null && isAudioContextRunning(context);
      if (want && !processing) {
        if (!bound) {
          track.setAudioContext(context);
          bound = true;
        }
        try {
          await track.setProcessor(new CallVoiceProcessor());
          processing = true;
        } catch (error) {
          failed = error; // graph unavailable on this engine: stay on the raw mic for the rest of the call
          await Promise.resolve(track.stopProcessor()).catch(() => undefined);
          return;
        }
        // The context may have been interrupted while the graph was being built.
        if (!isAudioContextRunning(context)) {
          await Promise.resolve(track.stopProcessor()).catch(() => undefined);
          processing = false;
        }
      } else if (!want && processing) {
        await Promise.resolve(track.stopProcessor()).catch(() => undefined);
        processing = false;
      }
    });
    return chain;
  };

  const onStateChange = () => void sync();
  context.addEventListener("statechange", onStateChange);
  await sync();
  if (failed !== null) {
    context.removeEventListener("statechange", onStateChange);
    throw failed;
  }
  return {
    publishRawIfNeeded: () => sync(),
    get processing() {
      return processing;
    },
    dispose: () => {
      disposed = true;
      context.removeEventListener("statechange", onStateChange);
    },
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
