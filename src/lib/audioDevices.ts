// Headset follow (Clubhouse-style): when a wired / USB-C / Bluetooth headset is plugged in or connected, the mic and
// playback move to it; when it is removed they fall back to the phone (the OS default). The browser exposes this as
// a `devicechange` event; the live microphone is then re-acquired on the default input so the headset mic is used.
// Shared by calls (LiveKit + Mediasoup) and rooms.

export type InputSnapshot = readonly string[];

/** Stable key per audio input. Mobile Safari/WebView may hide deviceIds before permission, so fall back to label. */
export function inputKeys(devices: readonly Pick<MediaDeviceInfo, "kind" | "deviceId" | "label">[]): string[] {
  return devices
    .filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications")
    .map((d) => d.deviceId || d.label)
    .filter(Boolean)
    .sort();
}

/**
 * Re-acquire the mic when the set of inputs changed: a headset was added (switch to it) or the current one was removed
 * (fall back). Identical sets (e.g. an output-only change) never restart the track, so there is no needless blip.
 */
export function shouldReacquireMic(prev: InputSnapshot | null, next: InputSnapshot, currentId?: string | null): { reacquire: boolean; reason: "added" | "removed" | "current-gone" | null } {
  if (!prev) return { reacquire: false, reason: null };
  const p = new Set(prev), n = new Set(next);
  if (currentId && currentId !== "default" && currentId !== "communications" && p.has(currentId) && !n.has(currentId)) return { reacquire: true, reason: "current-gone" };
  if (next.some((k) => !p.has(k))) return { reacquire: true, reason: "added" };
  if (prev.some((k) => !n.has(k))) return { reacquire: true, reason: "removed" };
  return { reacquire: false, reason: null };
}

/**
 * Watch device changes (debounced: Bluetooth connects fire several events). Calls `onChange` when the mic should be
 * re-acquired. Returns an unsubscribe function. No-op where mediaDevices is unavailable.
 */
export function followAudioDevices(onChange: (reason: "added" | "removed" | "current-gone") => void, currentId: () => string | null | undefined = () => null, debounceMs = 400): () => void {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  if (!md?.enumerateDevices || !md.addEventListener) return () => {};
  let prev: string[] | null = null, timer: ReturnType<typeof setTimeout> | null = null, stopped = false;
  const snap = async () => inputKeys(await md.enumerateDevices().catch(() => [] as MediaDeviceInfo[]));
  void snap().then((s) => { if (prev === null) prev = s; });
  const run = async () => {
    const next = await snap();
    if (stopped) return;
    const d = shouldReacquireMic(prev, next, currentId());
    prev = next;
    if (d.reacquire && d.reason) onChange(d.reason);
  };
  const handler = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void run(), debounceMs); };
  md.addEventListener("devicechange", handler);
  return () => { stopped = true; if (timer) clearTimeout(timer); md.removeEventListener("devicechange", handler); };
}
