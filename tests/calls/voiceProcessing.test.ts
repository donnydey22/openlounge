import { test } from "node:test";
import assert from "node:assert/strict";
import { CALL_MIC_COMPRESSOR, CALL_MIC_GAIN, CallVoiceProcessor, enableVoiceProcessing } from "../../src/lib/calls/voiceProcessing";

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
  state: AudioContextState = "running";
  private readonly listeners = new Set<() => void>();
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
  addEventListener(type: string, listener: () => void) {
    if (type === "statechange") this.listeners.add(listener);
  }
  removeEventListener(type: string, listener: () => void) {
    if (type === "statechange") this.listeners.delete(listener);
  }
  setState(state: AudioContextState) {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

class FakeProcessorTrack {
  contexts: unknown[] = [];
  processors = 0;
  stops = 0;
  setAudioContext(context: AudioContext) {
    this.contexts.push(context);
  }
  async setProcessor() {
    this.processors++;
  }
  async stopProcessor() {
    this.stops++;
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

test("suspended audio context leaves the raw microphone untouched", async () => {
  const context = new FakeContext();
  context.setState("suspended");
  const track = new FakeProcessorTrack();

  const handle = await enableVoiceProcessing(track, context as unknown as AudioContext);

  assert.equal(handle, null);
  assert.equal(track.contexts.length, 0, "do not bind a suspended context to the LiveKit microphone track");
  assert.equal(track.processors, 0, "do not publish a suspended destination track");
  assert.equal(track.stops, 0, "raw microphone needs no processor cleanup");
});

test("an interrupted audio context immediately restores the raw microphone track", async () => {
  const context = new FakeContext();
  const track = new FakeProcessorTrack();
  const handle = await enableVoiceProcessing(track, context as unknown as AudioContext);

  assert.ok(handle);
  assert.equal(track.contexts.length, 1);
  assert.equal(track.processors, 1);
  context.setState("suspended");
  await handle.publishRawIfNeeded();
  assert.equal(track.stops, 1, "processor is removed after suspension so LiveKit republishes the raw mic");
  handle.dispose();
});
