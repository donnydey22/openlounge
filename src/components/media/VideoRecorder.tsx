"use client";
// Telegram-style video message: record a short clip from the front (or back) camera right in the chat, preview it in
// a round frame, then hand it to the normal attach → upload pipeline (server: H.264 faststart/transcode, poster,
// adaptive HLS). Self-hosted only. Records VP8/VP9+Opus WebM (Chrome, Edge, Firefox, Android) or H.264+AAC MP4
// (Safari / iOS 14.3+).
import { useCallback, useEffect, useRef, useState } from "react";
import { Circle, RotateCcw, SendHorizontal, Square, SwitchCamera } from "lucide-react";
import { Sheet } from "../Sheet";
import { formatDuration } from "@/lib/media/types";
import {
  CHAT_AUDIO_CAPTURE_CONSTRAINTS,
  VIDEO_NOTE_AUDIO_BITS_PER_SECOND,
  VIDEO_NOTE_CAPTURE_CONSTRAINTS,
  VIDEO_NOTE_VIDEO_BITS_PER_SECOND,
} from "@/lib/media/recordingPolicy";
import { createVideoMessageRecordingStream } from "@/lib/media/videoOrientation";

export const VIDEO_NOTE_MAX_MS = 60_000;
const MIN_MS = 700;

/** Video recorder mime in preference order; null when MediaRecorder is missing. */
export function videoRecorderMime(): string | null {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") return null;
  const prefs = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4", "video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"];
  for (const m of prefs) {
    try {
      if (MediaRecorder.isTypeSupported?.(m)) return m;
    } catch {}
  }
  return "";
}
export function canRecordVideo() {
  return typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && videoRecorderMime() !== null && window.isSecureContext !== false;
}

type Phase = "starting" | "ready" | "recording" | "review" | "error";

export function VideoRecorderSheet({ open, onClose, onRecorded }: { open: boolean; onClose: () => void; onRecorded: (file: File) => void }) {
  const [phase, setPhase] = useState<Phase>("starting");
  const [err, setErr] = useState<string | null>(null);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [elapsed, setElapsed] = useState(0);
  const [review, setReview] = useState<{ file: File; url: string } | null>(null);
  const live = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const rec = useRef<{ mr: MediaRecorder; chunks: Blob[]; t0: number; timer: ReturnType<typeof setInterval>; release: () => void } | null>(null);
  const recorderStarting = useRef(false);

  const stopStream = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  const startStream = useCallback(async (f: "user" | "environment") => {
    stopStream();
    setPhase("starting");
    setErr(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: f, ...VIDEO_NOTE_CAPTURE_CONSTRAINTS },
        audio: CHAT_AUDIO_CAPTURE_CONSTRAINTS,
      });
      stream.current = s;
      if (live.current) {
        live.current.srcObject = s;
        await live.current.play().catch(() => {});
      }
      setPhase("ready");
    } catch (e) {
      const n = String((e as Error)?.name ?? "");
      setErr(/NotAllowed|Security/.test(n) ? "Allow camera and microphone access to record a video message" : "Camera unavailable");
      setPhase("error");
    }
  }, [stopStream]);

  const clearReview = useCallback(() => {
    setReview((r) => (r && URL.revokeObjectURL(r.url), null));
  }, []);

  useEffect(() => {
    if (!open) return;
    if (!canRecordVideo()) {
      setErr("Video recording isn't supported in this browser. Use Camera or Photo or video instead.");
      setPhase("error");
      return;
    }
    void startStream(facing);
    return () => {
      const r = rec.current;
      if (r) {
        clearInterval(r.timer);
        r.release();
        r.mr.ondataavailable = null;
        r.mr.onstop = null;
        try {
          r.mr.stop();
        } catch {}
        rec.current = null;
      }
      recorderStarting.current = false;
      stopStream();
      clearReview();
      setElapsed(0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (re)start only when opened
  }, [open]);

  const stop = useCallback(() => {
    const r = rec.current;
    if (!r) return;
    clearInterval(r.timer);
    try {
      r.mr.stop();
    } catch {}
  }, []);

  const start = async () => {
    const s = stream.current;
    if (!s || rec.current || recorderStarting.current) return;
    recorderStarting.current = true;
    setPhase("starting");
    // The front-camera recording is flipped in the pixels to match the selfie preview, so
    // review, bubble and player show exactly what the sender saw, with no playback CSS.
    const recording = await createVideoMessageRecordingStream(s, facing).catch(() => null);
    // The sheet may have closed or switched lenses while the helper awaited its first frame.
    if (!recording || stream.current !== s || rec.current) {
      recording?.release();
      recorderStarting.current = false;
      if (stream.current === s) setPhase("ready");
      return;
    }
    const mime = videoRecorderMime() || undefined;
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(recording.stream, {
        ...(mime ? { mimeType: mime } : {}),
        videoBitsPerSecond: VIDEO_NOTE_VIDEO_BITS_PER_SECOND,
        audioBitsPerSecond: VIDEO_NOTE_AUDIO_BITS_PER_SECOND,
      });
    } catch {
      try {
        mr = new MediaRecorder(recording.stream);
      } catch {
        recording.release();
        recorderStarting.current = false;
        setErr("Video recording couldn't start");
        setPhase("error");
        return;
      }
    }
    const chunks: Blob[] = [];
    const t0 = Date.now();
    mr.ondataavailable = (e) => e.data?.size && chunks.push(e.data);
    mr.onstop = () => {
      const dur = Date.now() - t0;
      rec.current = null;
      recording.release();
      if (dur < MIN_MS || !chunks.length) {
        setPhase("ready");
        setElapsed(0);
        return;
      }
      const type = (mr.mimeType || mime || "video/webm").split(";")[0];
      const ext = type.includes("mp4") ? "mp4" : "webm";
      const file = new File(chunks, `video-message-${new Date(t0).toISOString().replace(/[:.]/g, "-")}.${ext}`, { type });
      setReview({ file, url: URL.createObjectURL(file) });
      setPhase("review");
      stopStream();
    };
    const timer = setInterval(() => {
      const ms = Date.now() - t0;
      setElapsed(ms);
      if (ms >= VIDEO_NOTE_MAX_MS) stop();
    }, 200);
    rec.current = { mr, chunks, t0, timer, release: recording.release };
    try {
      mr.start(1000);
    } catch {
      clearInterval(timer);
      rec.current = null;
      recording.release();
      recorderStarting.current = false;
      setErr("Video recording couldn't start");
      setPhase("error");
      return;
    }
    recorderStarting.current = false;
    setElapsed(0);
    setPhase("recording");
  };

  const retake = () => {
    clearReview();
    setElapsed(0);
    void startStream(facing);
  };
  const flip = () => {
    const f = facing === "user" ? "environment" : "user";
    setFacing(f);
    void startStream(f);
  };
  const use = () => {
    if (!review) return;
    const f = review.file;
    onRecorded(f);
  };

  const pct = Math.min(1, elapsed / VIDEO_NOTE_MAX_MS);
  return (
    <Sheet open={open} onClose={onClose} title="Video message">
      <div className="flex flex-col items-center gap-4 pb-3" data-testid="video-recorder">
        <div className="relative aspect-square w-[min(72vw,320px)]">
          <svg className="pointer-events-none absolute -inset-1.5 h-[calc(100%+12px)] w-[calc(100%+12px)] -rotate-90" viewBox="0 0 100 100" aria-hidden>
            <circle cx="50" cy="50" r="48" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="2" />
            {phase === "recording" && <circle cx="50" cy="50" r="48" fill="none" stroke="#f43f5e" strokeWidth="2.5" strokeDasharray={`${pct * 301.6} 301.6`} strokeLinecap="round" />}
          </svg>
          <div className="h-full w-full overflow-hidden rounded-full bg-zinc-950 ring-1 ring-white/10">
            {review ? (
              <video key={review.url} src={review.url} playsInline controls autoPlay loop className="h-full w-full object-cover" data-testid="video-recorder-review" />
            ) : (
              <video
                ref={live}
                playsInline
                muted
                autoPlay
                className="h-full w-full object-cover"
                // Deliberately display-only: the recorder receives an unstyled, normalized stream.
                style={{ transform: facing === "user" ? "scaleX(-1) translateZ(0)" : "translateZ(0)" }}
                data-testid="video-recorder-live"
              />
            )}
          </div>
          {phase === "error" && <div className="absolute inset-0 flex items-center justify-center rounded-full p-6 text-center text-sm text-zinc-300">{err}</div>}
        </div>
        <div className="h-5 text-sm tabular-nums text-zinc-400" aria-live="polite">
          {phase === "recording" ? `● ${formatDuration(elapsed)} / ${formatDuration(VIDEO_NOTE_MAX_MS)}` : phase === "review" ? formatDuration(elapsed) : phase === "ready" ? "Up to 1 minute" : ""}
        </div>
        <div className="flex items-center justify-center gap-6">
          {phase === "review" ? (
            <>
              <button type="button" onClick={retake} aria-label="Retake" data-testid="video-recorder-retake" className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800 text-zinc-200 hover:bg-zinc-700">
                <RotateCcw className="h-5 w-5" />
              </button>
              <button type="button" onClick={use} aria-label="Use video" data-testid="video-recorder-use" className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-ink hover:bg-emerald-400">
                <SendHorizontal className="h-7 w-7" />
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={flip} disabled={phase === "recording" || phase === "error"} aria-label="Switch camera" className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:opacity-40">
                <SwitchCamera className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={phase === "recording" ? stop : start}
                disabled={phase !== "ready" && phase !== "recording"}
                aria-label={phase === "recording" ? "Stop recording" : "Start recording"}
                data-testid="video-recorder-toggle"
                className="flex h-16 w-16 items-center justify-center rounded-full bg-rose-500 text-white hover:bg-rose-400 disabled:opacity-40"
              >
                {phase === "recording" ? <Square className="h-6 w-6 fill-current" /> : <Circle className="h-7 w-7 fill-current" />}
              </button>
              <div className="h-12 w-12" />
            </>
          )}
        </div>
      </div>
    </Sheet>
  );
}
