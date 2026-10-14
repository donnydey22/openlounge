// #49: never show a placeholder (native poster, play button, blank or white tile) when call video blips.
// The <video> stays mounted with the same srcObject; a canvas holds the last decoded frame and is shown only
// while frames are not arriving (stall, mute, ended, track swap). It hides the instant a new frame paints.
// Visibility flips are instant (no CSS transition) so there is never a flash.

type FrameCb = (now: number, meta: unknown) => void;
type RVFCVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: FrameCb) => number; cancelVideoFrameCallback?: (h: number) => void };

/** How often (ms) the live frame is copied into the hold canvas. */
export const CAPTURE_EVERY_MS = 200;
/** No new frame for this long while playing counts as a stall (covers stacks that fire no event). */
export const STALL_AFTER_MS = 700;
/** Live frames needed before a held picture is released. WebKit reports the first frame of a swapped-in track
 *  (videoWidth set, rVFC fired) a few frames before it actually paints it, so releasing on frame 1 flashes blank. */
export const RELEASE_AFTER_FRAMES = 4;

/** Copy the video's current frame to the canvas; false when nothing is decodable (keeps the previous copy). */
export function captureFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): boolean {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h || video.readyState < 2) return false;
  try {
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.getContext("2d")?.drawImage(video, 0, 0, w, h);
    return true;
  } catch {
    return false;
  }
}

/** Resume a call <video> that the browser/OS paused or stalled. Safe to call repeatedly. */
export function resumeVideo(video: HTMLVideoElement) {
  if (!video.srcObject) return;
  if (video.paused || video.readyState < 3) void video.play().catch(() => {});
}

export function holdFrames(video: HTMLVideoElement, canvas: HTMLCanvasElement): () => void {
  const v = video as RVFCVideo;
  let held = false;
  let hasFrame = false;
  let lastFrameAt = 0;
  let lastCaptureAt = 0;
  let rvfc = 0;
  let disposed = false;
  let liveRun = 0;
  const tracked = new Set<MediaStreamTrack>();

  const setHeld = (on: boolean) => {
    on = on && hasFrame; // nothing captured yet → nothing to hold; the element's own background stays
    if (on) liveRun = 0;
    if (held === on) return;
    held = on;
    canvas.style.visibility = on ? "visible" : "hidden";
    canvas.dataset.held = on ? "1" : "0";
  };
  // a frame only counts as live when a live, unmuted track is feeding the element: a stopped/ended/muted track can
  // still paint a final black frame, which must neither hide the hold nor replace the held picture
  const live = () => {
    const s = video.srcObject as MediaStream | null;
    const ts = s?.getVideoTracks?.();
    if (!ts) return !!video.srcObject;
    return ts.some((t) => t.readyState === "live" && !t.muted);
  };
  const onFrame = () => {
    if (!live()) { liveRun = 0; return; }
    const now = performance.now();
    lastFrameAt = now;
    if (video.videoWidth > 0) {
      // while holding, keep the held picture: frames right after a swap may not be painted yet (would capture blank)
      if (held && liveRun + 1 < RELEASE_AFTER_FRAMES) { liveRun++; return; }
      if (!hasFrame || now - lastCaptureAt >= CAPTURE_EVERY_MS) {
        if (captureFrame(video, canvas)) {
          hasFrame = true;
          lastCaptureAt = now;
        }
      }
      setHeld(false);
    }
  };
  const loop: FrameCb = () => {
    if (disposed) return;
    onFrame();
    rvfc = v.requestVideoFrameCallback!(loop);
  };
  const freeze = () => {
    // Do not re-capture here: a stopped/ended track can already be painting black, which would overwrite the
    // good frame. The rolling capture (every CAPTURE_EVERY_MS of live frames) is the frame we hold.
    setHeld(true);
    resumeVideo(video);
  };
  const onTrackMute = () => freeze();
  const onTrackUnmute = () => resumeVideo(video);
  const bindTracks = () => {
    const s = video.srcObject as MediaStream | null;
    const now = new Set(s?.getVideoTracks?.() ?? []);
    for (const t of tracked) if (!now.has(t)) {
      t.removeEventListener("mute", onTrackMute);
      t.removeEventListener("unmute", onTrackUnmute);
      t.removeEventListener("ended", onTrackMute);
      tracked.delete(t);
    }
    for (const t of now) if (!tracked.has(t)) {
      t.addEventListener("mute", onTrackMute);
      t.addEventListener("unmute", onTrackUnmute);
      t.addEventListener("ended", onTrackMute);
      tracked.add(t);
    }
  };
  const onStream = (e: Event) => {
    const t = (e as MediaStreamTrackEvent).track;
    if (e.type === "removetrack" && t?.kind === "video") freeze();
    bindTracks();
    resumeVideo(video);
  };
  let stream: MediaStream | null = null;
  const watchStream = () => {
    const s = (video.srcObject as MediaStream | null) ?? null;
    if (s === stream) return;
    stream?.removeEventListener?.("addtrack", onStream);
    stream?.removeEventListener?.("removetrack", onStream);
    stream = s;
    stream?.addEventListener?.("addtrack", onStream);
    stream?.addEventListener?.("removetrack", onStream);
    bindTracks();
  };

  const stallEvents = ["stalled", "waiting", "pause", "suspend", "emptied", "ended"] as const;
  const onStall = () => {
    watchStream();
    freeze();
  };
  const onMeta = () => {
    watchStream();
    resumeVideo(video);
  };
  for (const ev of stallEvents) video.addEventListener(ev, onStall);
  video.addEventListener("loadedmetadata", onMeta);
  video.addEventListener("loadstart", onMeta);
  if (typeof v.requestVideoFrameCallback === "function") rvfc = v.requestVideoFrameCallback(loop);
  else video.addEventListener("timeupdate", onFrame);

  // watchdog: some WebViews just stop painting without any event
  const dog = window.setInterval(() => {
    watchStream();
    if (!hasFrame) return;
    if (performance.now() - lastFrameAt > STALL_AFTER_MS) freeze();
  }, 250);

  canvas.style.visibility = "hidden";
  canvas.dataset.held = "0";
  watchStream();
  onFrame();
  return () => {
    disposed = true;
    window.clearInterval(dog);
    if (rvfc && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(rvfc);
    for (const ev of stallEvents) video.removeEventListener(ev, onStall);
    video.removeEventListener("loadedmetadata", onMeta);
    video.removeEventListener("loadstart", onMeta);
    video.removeEventListener("timeupdate", onFrame);
    stream?.removeEventListener?.("addtrack", onStream);
    stream?.removeEventListener?.("removetrack", onStream);
    for (const t of tracked) {
      t.removeEventListener("mute", onTrackMute);
      t.removeEventListener("unmute", onTrackUnmute);
      t.removeEventListener("ended", onTrackMute);
    }
  };
}

/** Phone viewport: <=600px wide, or a touch device in landscape <=600px tall (matches calls.module.css). */
export function isPhoneViewport(sw: number, sh: number, coarse = true): boolean {
  return sw <= 600 || (coarse && sh <= 600 && sw > sh);
}

/** Phones cover edge to edge (Telegram); tablets/desktop contain (whole picture) over a blurred backdrop. */
export function videoFit(_vw: number, _vh: number, sw: number, sh: number, coarse = true): "cover" | "contain" {
  return isPhoneViewport(sw, sh, coarse) ? "cover" : "contain";
}

/** Keep `backdrop` showing the same MediaStream as `video` (shared stream object, no extra decode setup). */
export function mirrorBackdrop(video: HTMLVideoElement, backdrop: HTMLVideoElement): () => void {
  const sync = () => {
    if (backdrop.srcObject !== video.srcObject) backdrop.srcObject = video.srcObject;
    if (backdrop.srcObject && backdrop.paused) void backdrop.play?.()?.catch?.(() => {});
  };
  sync();
  const evs = ["loadedmetadata", "playing", "emptied"] as const;
  for (const e of evs) video.addEventListener(e, sync);
  const id = setInterval(sync, 1000);
  return () => {
    clearInterval(id);
    for (const e of evs) video.removeEventListener(e, sync);
    backdrop.srcObject = null;
  };
}

/**
 * Put `track` on the element without replacing srcObject: the same MediaStream keeps playing, the old video track is
 * swapped out in place. A null track leaves the stream (and its last frame) alone.
 */
export function swapVideoTrack(el: HTMLVideoElement, track: MediaStreamTrack | null) {
  if (!track) return;
  const cur = el.srcObject;
  if (cur && typeof (cur as MediaStream).getVideoTracks === "function") {
    const s = cur as MediaStream;
    if (s.getVideoTracks().includes(track)) return resumeVideo(el);
    s.addTrack(track);
    for (const t of s.getVideoTracks()) if (t !== track) s.removeTrack(t);
  } else {
    el.srcObject = new MediaStream([track]);
  }
  resumeVideo(el);
}
