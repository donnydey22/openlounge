// AudioWorklet: 128-frame float blocks <-> 960-sample Int16 frames (20 ms @ 48 kHz). Small playout FIFO.
class OlPcm extends AudioWorkletProcessor {
  constructor() { super(); this.cap = new Int16Array(960); this.n = 0; this.play = []; this.off = 0;
    this.port.onmessage = (e) => { if (this.play.length < 10) this.play.push(e.data); }; }
  process(inputs, outputs) {
    const i = inputs[0][0], o = outputs[0][0];
    if (i) for (let k = 0; k < i.length; k++) { this.cap[this.n++] = Math.max(-1, Math.min(1, i[k])) * 32767; if (this.n === 960) { this.port.postMessage(this.cap.slice()); this.n = 0; } }
    for (let k = 0; k < o.length; k++) { const f = this.play[0]; if (!f) { o[k] = 0; continue; } o[k] = f[this.off++] / 32768; if (this.off >= f.length) { this.play.shift(); this.off = 0; } }
    return true;
  }
}
registerProcessor("ol-pcm", OlPcm);
