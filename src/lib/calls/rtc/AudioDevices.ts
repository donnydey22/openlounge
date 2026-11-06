// Browser audio device enumeration (mirrors Signal Desktop's input/output device lists) — never assumes index 0.
export interface AudioDevice { id: string; label: string; kind: "input" | "output"; isDefault: boolean }

export function sinkSupported(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

export async function listAudioDevices(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [] };
  const all = await navigator.mediaDevices.enumerateDevices();
  const map = (d: MediaDeviceInfo, kind: AudioDevice["kind"], i: number): AudioDevice => ({ id: d.deviceId, label: d.label || `${kind === "input" ? "Microphone" : "Speaker"} ${i + 1}`, kind, isDefault: d.deviceId === "default" || d.deviceId === "" });
  return {
    inputs: all.filter((d) => d.kind === "audioinput").map((d, i) => map(d, "input", i)),
    outputs: sinkSupported() ? all.filter((d) => d.kind === "audiooutput").map((d, i) => map(d, "output", i)) : [],
  };
}

/** Watch hotplug; returns unsubscribe. A selected device that disappears falls back to the system default. */
export function watchAudioDevices(fn: (d: { inputs: AudioDevice[]; outputs: AudioDevice[] }) => void): () => void {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!md?.addEventListener) return () => {};
  const h = () => void listAudioDevices().then(fn).catch(() => {});
  md.addEventListener("devicechange", h);
  return () => md.removeEventListener("devicechange", h);
}

export function stillPresent(id: string | null, list: AudioDevice[]): string | null {
  return id && list.some((d) => d.id === id) ? id : null;
}
