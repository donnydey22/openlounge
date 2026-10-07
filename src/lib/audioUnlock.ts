// Autoplay unlock that works in desktop/mobile browsers, the Android WebView APK and iOS
// WKWebView. Call unlockAudio() synchronously inside a user tap (join room, Let's Go, mic
// toggle, "Tap to enable audio"): it resumes a shared AudioContext, plays a silent buffer
// (the iOS-required "gesture play"), and asks the active LiveKit room to start playback.

type StartableRoom = { startAudio(): Promise<void>; canPlaybackAudio: boolean };

let ctx: AudioContext | null = null;
let activeRoom: StartableRoom | null = null;

/** The hook registers the connected LiveKit room so taps anywhere can unlock it. */
export function setActiveAudioRoom(room: StartableRoom | null) {
  activeRoom = room;
}

export function unlockAudio(): void {
  if (typeof window === "undefined") return;
  try {
    const AC: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AC) {
      if (!ctx) ctx = new AC();
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      // one-sample silent buffer: satisfies iOS's "must start audio inside a gesture" rule
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    }
  } catch {
    /* no Web Audio — LiveKit's startAudio below still runs */
  }
  void activeRoom?.startAudio().catch(() => {});
}
