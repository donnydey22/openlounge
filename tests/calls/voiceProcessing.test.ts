import { test } from "node:test";
import assert from "node:assert/strict";
import { CALL_MIC_COMPRESSOR, CALL_MIC_GAIN, CallVoiceProcessor } from "../../src/lib/calls/voiceProcessing";

class FakeNode {
  next: FakeNode | undefined;
  disconnected = false;
  connect<T extends FakeNode>(next: T) {
    this.next = next;
    return next;
  }
  disconnect() {
    this.disconnected = true;
  }
}

class FakeContext {
  source = new FakeNode();
  gain = Object.assign(new FakeNode(), { gain: { value: 0 } });
  compressor = Object.assign(new FakeNode(), {
    threshold: { value: 0 },
    knee: { value: 0 },
    ratio: { value: 0 },
    attack: { value: 0 },
    release: { value: 0 },
  });
  outputStopped = false;
  destination = Object.assign(new FakeNode(), {
    stream: { getAudioTracks: () => [({ stop: () => (this.outputStopped = true) } as unknown as MediaStreamTrack)] },
  });
  createMediaStreamSource() {
    return this.source;
  }
  createGain() {
    return this.gain;
  }
  createDynamicsCompressor() {
    return this.compressor;
  }
  createMediaStreamDestination() {
    return this.destination;
  }
}

test("voice processor raises quiet input while retaining a compressor safety ceiling", async () => {
  const saved = globalThis.MediaStream;
  (globalThis as unknown as { MediaStream: new (tracks: MediaStreamTrack[]) => unknown }).MediaStream = class {
    constructor(readonly tracks: MediaStreamTrack[]) {}
  };
  try {
    const context = new FakeContext();
    const processor = new CallVoiceProcessor();
    await processor.init({ track: {} as MediaStreamTrack, audioContext: context as unknown as AudioContext });
    assert.equal(context.gain.gain.value, CALL_MIC_GAIN);
    assert.deepEqual(
      [context.compressor.threshold.value, context.compressor.knee.value, context.compressor.ratio.value, context.compressor.attack.value, context.compressor.release.value],
      [CALL_MIC_COMPRESSOR.threshold, CALL_MIC_COMPRESSOR.knee, CALL_MIC_COMPRESSOR.ratio, CALL_MIC_COMPRESSOR.attack, CALL_MIC_COMPRESSOR.release],
    );
    assert.equal(context.source.next, context.gain);
    assert.equal(context.gain.next, context.compressor);
    assert.equal(context.compressor.next, context.destination);
    assert.ok(processor.processedTrack);
    await processor.destroy();
    assert.equal(context.outputStopped, true);
    assert.equal(context.source.disconnected, true);
    assert.equal(processor.processedTrack, undefined);
  } finally {
    (globalThis as unknown as { MediaStream: typeof MediaStream }).MediaStream = saved;
  }
});
