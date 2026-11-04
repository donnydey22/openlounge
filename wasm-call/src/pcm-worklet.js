// AudioWorklet: device-rate float blocks <-> 960-sample Int16 frames (20 ms @ 48 kHz).
// Works at any AudioContext rate (Firefox/Safari may run 44.1 kHz): linear resampling both ways.
// Playout: small adaptive FIFO (target 2-3 frames, hard cap 8 = 160 ms, oldest dropped) so latency never builds up.
// Output goes to every channel (stereo destinations used to get left-ear-only audio).
class OlPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.r = sampleRate / 48000; // device samples per 48 kHz sample
    this.cap = new Int16Array(960); this.n = 0; this.capPos = 0; this.capPrev = 0;
    this.play = []; this.pos = 0; this.under = 0;
    this.port.onmessage = (e) => { this.play.push(e.data); while (this.play.length > 8) { this.play.shift(); this.pos = 0; } };
  }
  pushCap(v) { this.cap[this.n++] = Math.max(-1, Math.min(1, v)) * 32767; if (this.n === 960) { this.port.postMessage(this.cap.slice()); this.n = 0; } }
  process(inputs, outputs) {
    const i = inputs[0] && inputs[0][0], out = outputs[0];
    if (i) {
      if (this.r === 1) for (let k = 0; k < i.length; k++) this.pushCap(i[k]);
      else { // device -> 48 kHz: step 1/r device samples per output sample
        const step = this.r; let p = this.capPos;
        while (p < i.length) { const a = Math.floor(p), f = p - a; const s0 = a === 0 ? (f === 0 ? i[0] : this.capPrev) : i[a - 1]; const s1 = i[a]; this.pushCap(a === 0 && f === 0 ? s1 : s0 + (s1 - s0) * f); p += step; }
        this.capPos = p - i.length; this.capPrev = i[i.length - 1];
      }
    }
    const o = out[0]; if (!o) return true;
    const step = 1 / this.r; // 48 kHz samples per device sample
    for (let k = 0; k < o.length; k++) {
      const f = this.play[0];
      if (!f) { o[k] = 0; this.under++; continue; }
      const a = Math.floor(this.pos), fr = this.pos - a;
      const s0 = f[a] / 32768, s1 = (a + 1 < f.length ? f[a + 1] : (this.play[1] ? this.play[1][0] : f[a])) / 32768;
      o[k] = s0 + (s1 - s0) * fr;
      this.pos += step; if (this.pos >= f.length) { this.pos -= f.length; this.play.shift(); }
    }
    for (let c = 1; c < out.length; c++) out[c].set(o);
    return true;
  }
}
registerProcessor("ol-pcm", OlPcm);
