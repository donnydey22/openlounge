// Test double for the call engine: same snapshot/subscribe surface the overlay uses, fake camera feeds from canvases.
import type { CallSnapshot } from "../../../src/lib/calls/engine";
export type { CallSnapshot } from "../../../src/lib/calls/engine";

export const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const feeds: Record<"local" | "remote", { stream: MediaStream | null; live: boolean }> = { local: { stream: null, live: false }, remote: { stream: null, live: false } };
function makeFeed(which: "local" | "remote") {
  const c = document.createElement("canvas");
  c.width = 360;
  c.height = 640;
  const g = c.getContext("2d")!;
  let f = 0;
  setInterval(() => {
    f++;
    g.fillStyle = which === "remote" ? "#d97706" : "#2563eb";
    g.fillRect(0, 0, 360, 640);
    g.fillStyle = "#fff";
    g.font = "bold 48px sans-serif";
    g.fillText(which === "remote" ? "KEIKO" : "ME", 100, 300);
    g.fillRect((f * 6) % 360, 400, 40, 40);
  }, 33);
  return (c as HTMLCanvasElement & { captureStream(fps: number): MediaStream }).captureStream(30);
}
const els: Record<"local" | "remote", HTMLVideoElement[]> = { local: [], remote: [] };
function wire(which: "local" | "remote") {
  for (const el of els[which]) {
    const want = feeds[which].live ? feeds[which].stream : null;
    if (el.srcObject !== want) el.srcObject = want;
  }
}

const base: CallSnapshot = {
  call: null, role: null, ui: null, minimized: false, muted: false, camOn: false, facing: "user", remoteCam: false, remoteMuted: false,
  speaker: false, speakerSupported: false, quality: "good", reconnecting: false, peerReconnecting: false, connectedAt: null, endedText: null,
  canRetry: false, endedVideo: false, error: null, needsGesture: false, videoInvite: false, nativeAudio: false, nativeVideo: false, elsewhere: null, v: 0,
} as CallSnapshot;

class Stub {
  s: CallSnapshot = { ...base };
  ls = new Set<() => void>();
  subscribe(l: () => void) {
    this.ls.add(l);
    return () => this.ls.delete(l);
  }
  snapshot() {
    return this.s;
  }
  set(p: Partial<CallSnapshot>) {
    this.s = { ...this.s, ...p, v: this.s.v + 1 };
    this.ls.forEach((l) => l());
  }
  reset() {
    this.s = { ...base, v: this.s.v + 1 };
    this.ls.forEach((l) => l());
  }
  feed(which: "local" | "remote", live: boolean) {
    const f = feeds[which];
    if (live && !f.stream) f.stream = makeFeed(which);
    if (!live && f.stream) {
      f.stream.getTracks().forEach((t) => t.stop());
      f.stream = null;
    }
    f.live = live;
    wire(which);
  }
  attachVideo(which: "local" | "remote", el: HTMLVideoElement | null) {
    for (const old of els[which]) if (old !== el) old.srcObject = null;
    els[which] = el ? [el] : [];
    wire(which);
  }
  freeze() {
    for (const el of [...els.remote, ...els.local]) el.dispatchEvent(new Event("olcall:freeze"));
  }
  setMinimized() {}
  dismiss() { this.reset(); }
  retry() {}
  toggleCam() {}
  toggleMute() {}
  flip() {}
  hangup() {}
  accept() {}
  decline() {}
  startAudio() {}
  clearError() {}
  dismissVideoInvite() {}
  toggleSpeaker() {}
}
export const callEngine = new Stub() as unknown as Stub & Record<string, (...a: unknown[]) => unknown>;
(window as unknown as { callStub: Stub }).callStub = callEngine;
