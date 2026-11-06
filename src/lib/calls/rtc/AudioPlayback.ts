// One remote-audio playout element per call. Handles autoplay rejection (local, retried on next user gesture) and
// output selection via setSinkId where supported. Never triggers network recovery.
import { CallFailure, fromMediaError } from "./CallFailures";
import { sinkSupported } from "./AudioDevices";

export class AudioPlayback {
  private el: HTMLAudioElement | null = null;
  private gestureRetry: (() => void) | null = null;
  outputId: string | null = null;
  onFailure?: (f: CallFailure) => void;

  attach(stream: MediaStream) {
    if (typeof document === "undefined") return;
    if (!this.el) {
      const el = document.createElement("audio");
      el.autoplay = true;
      el.setAttribute("playsinline", "");
      el.dataset.olCallAudio = "remote";
      el.style.display = "none";
      document.body.appendChild(el);
      this.el = el;
    }
    if (this.el.srcObject !== stream) this.el.srcObject = stream;
    if (this.outputId) void this.setOutput(this.outputId);
    void this.play();
  }

  private async play() {
    const el = this.el;
    if (!el) return;
    try {
      await el.play();
    } catch (e) {
      this.onFailure?.(fromMediaError(e));
      if (!this.gestureRetry && typeof document !== "undefined") {
        const h = () => { this.clearGesture(); void this.play(); };
        this.gestureRetry = h;
        document.addEventListener("pointerdown", h, { once: true });
        document.addEventListener("keydown", h, { once: true });
      }
    }
  }

  private clearGesture() {
    if (!this.gestureRetry) return;
    document.removeEventListener("pointerdown", this.gestureRetry);
    document.removeEventListener("keydown", this.gestureRetry);
    this.gestureRetry = null;
  }

  async setOutput(id: string | null): Promise<boolean> {
    this.outputId = id;
    const el = this.el as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!el || !sinkSupported() || !el.setSinkId) return false;
    try { await el.setSinkId(id ?? ""); return true; } catch (e) { this.onFailure?.(fromMediaError(e)); return false; }
  }

  close() {
    this.clearGesture();
    if (this.el) {
      this.el.pause();
      this.el.srcObject = null;
      this.el.remove();
      this.el = null;
    }
  }
}
