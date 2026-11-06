// The single owner of call microphone capture in the browser. One permission-gated getUserMedia per call; WebRTC
// (the browser's engine) owns AEC/NS/AGC and resampling — no custom DSP, no AudioContext graph, no priming.
import { CallFailure, fromMediaError } from "./CallFailures";

export const CALL_AUDIO_CONSTRAINTS: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };

export class BrowserAudioOwner {
  private stream: MediaStream | null = null;
  private closed = false;
  private _muted = false;
  inputId: string | null = null;

  get track(): MediaStreamTrack | null {
    return this.stream?.getAudioTracks()[0] ?? null;
  }

  /** permission → device-open. Throws CallFailure (local). Retries once on the default device if a chosen one fails. */
  async open(deviceId: string | null = this.inputId): Promise<MediaStreamTrack> {
    if (this.closed) throw new CallFailure("session", "closed");
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) throw new CallFailure("device", "no-getUserMedia");
    const get = (id: string | null) => navigator.mediaDevices.getUserMedia({ audio: { ...CALL_AUDIO_CONSTRAINTS, ...(id ? { deviceId: { exact: id } } : {}) }, video: false });
    let s: MediaStream;
    try {
      s = await get(deviceId);
    } catch (e) {
      const f = fromMediaError(e);
      if (f.kind !== "device" || !deviceId) throw f;
      try { s = await get(null); deviceId = null; } catch (e2) { throw fromMediaError(e2); }
    }
    if (this.closed) { s.getTracks().forEach((t) => t.stop()); throw new CallFailure("session", "closed"); }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = s;
    this.inputId = deviceId;
    const t = s.getAudioTracks()[0];
    if (!t) throw new CallFailure("device", "no-audio-track");
    t.enabled = !this._muted;
    return t;
  }

  /** Mute is a local track toggle only — it is never a transport signal and never triggers recovery. */
  setMuted(m: boolean) {
    this._muted = m;
    const t = this.track;
    if (t) t.enabled = !m;
  }

  get muted() { return this._muted; }

  close() {
    this.closed = true;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
