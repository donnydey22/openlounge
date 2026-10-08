"use client";
// Telegram-style voice notes: hold the mic to record, slide left to cancel, slide up to lock (hands-free), release to
// send. Live waveform + timer while recording. Records Opus/WebM (Chrome, Edge, Firefox, Android) or AAC/MP4
// (Safari, iOS); the server transcodes everything to AAC/m4a so every device plays it.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronUp, Lock, Mic, SendHorizontal, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration, VOICE_MAX_MS_CLIENT } from "./voiceConst";
import { canRecordVoice, recorderMime } from "@/lib/media/capabilities";
import { haptic } from "@/lib/native";

export interface Recorded {
  blob: Blob;
  durMs: number;
  /** 64 peaks 0..255, base64 (for the optimistic bubble; the server computes the real one) */
  wave: string;
}

type Phase = "idle" | "starting" | "recording" | "locked";
const CANCEL_PX = 110;
const LOCK_PX = 70;
const MIN_MS = 600;

function toPeaks(levels: number[], n = 64) {
  const out = new Uint8Array(n);
  if (!levels.length) return btoa(String.fromCharCode(...out));
  const max = Math.max(...levels, 0.02);
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * levels.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / n));
    let m = 0;
    for (let j = a; j < b; j++) m = Math.max(m, levels[j] ?? 0);
    out[i] = Math.round(Math.min(1, m / max) * 255);
  }
  return btoa(String.fromCharCode(...out));
}

export function VoiceRecordButton({ disabled, onRecorded, compact }: { disabled?: boolean; onRecorded: (r: Recorded) => void; compact?: boolean }) {
  const [supported, setSupported] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [drag, setDrag] = useState({ dx: 0, dy: 0 });
  const [hint, setHint] = useState<string | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; ctx?: AudioContext; t0: number; levels: number[]; raf: number; timer: ReturnType<typeof setInterval> } | null>(null);
  const pointerDown = useRef(false);
  const start0 = useRef({ x: 0, y: 0 });
  const bars = useRef<HTMLDivElement>(null);

  useEffect(() => setSupported(canRecordVoice()), []);

  const flash = (t: string) => {
    setHint(t);
    setTimeout(() => setHint(null), 2200);
  };

  const cleanup = useCallback(() => {
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    cancelAnimationFrame(r.raf);
    clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop());
    void r.ctx?.close().catch(() => {});
  }, []);
  useEffect(() => cleanup, [cleanup]);

  const finish = useCallback(
    (send: boolean) => {
      const r = rec.current;
      lockedRef.current = false;
      setPhase("idle");
      setDrag({ dx: 0, dy: 0 });
      if (!r) return;
      const durMs = Date.now() - r.t0;
      const levels = r.levels;
      if (r.mr.state === "inactive") return cleanup();
      r.mr.onstop = () => {
        const type = r.mr.mimeType || recorderMime() || "audio/webm";
        const blob = new Blob(r.chunks, { type });
        cleanup();
        if (!send) return;
        if (durMs < MIN_MS || blob.size < 500) return flash("Hold to record, release to send");
        const ext = type.includes("mp4") || type.includes("aac") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        onRecorded({ blob: new File([blob], `voice.${ext}`, { type }), durMs, wave: toPeaks(levels) });
      };
      try {
        r.mr.stop();
      } catch {
        cleanup();
      }
      haptic(send ? "light" : "medium");
    },
    [cleanup, onRecorded],
  );

  const lockedRef = useRef(false);
  const begin = async (locked = false) => {
    if (rec.current || phase !== "idle") return;
    lockedRef.current = locked;
    setPhase(locked ? "locked" : "starting");
    const t = Date.now();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      setPhase("idle");
      flash((e as Error).name === "NotAllowedError" ? "Allow microphone access to record voice messages" : "No microphone found");
      return;
    }
    // the permission prompt interrupted the hold: don't start a recording nobody is holding
    if (!pointerDown.current && Date.now() - t > 400 && !lockedRef.current) {
      stream.getTracks().forEach((x) => x.stop());
      setPhase("idle");
      flash("Hold to record, release to send");
      return;
    }
    const mime = recorderMime();
    let mr: MediaRecorder;
    try {
      mr = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 48_000 }) : new MediaRecorder(stream);
    } catch {
      mr = new MediaRecorder(stream);
    }
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.start(250);
    const r = { mr, stream, chunks, t0: Date.now(), levels: [] as number[], raf: 0, timer: setInterval(() => {}, 1000), ctx: undefined as AudioContext | undefined };
    clearInterval(r.timer);
    r.timer = setInterval(() => {
      const ms = Date.now() - r.t0;
      setElapsed(ms);
      if (ms >= VOICE_MAX_MS_CLIENT) finish(true);
    }, 200);
    // live level meter (AudioContext may be missing / suspended: the timer still runs)
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        void ctx.resume?.();
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        ctx.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.fftSize);
        let last = 0;
        const loop = (ts: number) => {
          r.raf = requestAnimationFrame(loop);
          if (ts - last < 60) return;
          last = ts;
          an.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const lvl = Math.sqrt(sum / buf.length);
          r.levels.push(lvl);
          paintBars(r.levels);
        };
        r.raf = requestAnimationFrame(loop);
        r.ctx = ctx;
      }
    } catch {}
    rec.current = r;
    setElapsed(0);
    setPhase(lockedRef.current ? "locked" : "recording");
    haptic("light");
  };

  const paintBars = (levels: number[]) => {
    const el = bars.current;
    if (!el) return;
    const n = el.children.length;
    const max = Math.max(0.05, ...levels.slice(-200));
    for (let i = 0; i < n; i++) {
      const v = levels[levels.length - n + i] ?? 0;
      (el.children[i] as HTMLElement).style.transform = `scaleY(${Math.max(0.12, Math.min(1, v / max))})`;
    }
  };

  const onDown = (e: React.PointerEvent) => {
    if (disabled) return;
    if (!supported) return flash("Voice messages aren't supported in this browser");
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointerDown.current = true;
    start0.current = { x: e.clientX, y: e.clientY };
    setRect((btn.current?.closest("form") ?? btn.current?.parentElement)?.getBoundingClientRect() ?? null);
    void begin();
  };
  const onMove = (e: React.PointerEvent) => {
    if (!pointerDown.current || phase === "locked") return;
    const dx = Math.min(0, e.clientX - start0.current.x);
    const dy = Math.min(0, e.clientY - start0.current.y);
    setDrag({ dx, dy });
    if (dx < -CANCEL_PX) {
      pointerDown.current = false;
      finish(false);
    } else if (dy < -LOCK_PX && rec.current) {
      pointerDown.current = false;
      lockedRef.current = true;
      setPhase("locked");
      setDrag({ dx: 0, dy: 0 });
      haptic("medium");
    }
  };
  const onUp = () => {
    if (!pointerDown.current) return;
    pointerDown.current = false;
    if (phase === "locked") return;
    if (!rec.current) {
      // released before the mic was ready (or a quick tap)
      setTimeout(() => {
        if (rec.current && !lockedRef.current) finish(false);
      }, 50);
      if (phase === "idle" || phase === "starting") flash("Hold to record, release to send");
      return;
    }
    finish(true);
  };

  const active = phase === "recording" || phase === "locked";
  const size = compact ? "h-[38px] w-[38px]" : "h-[42px] w-[42px]";
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={supported ? "Hold to record a voice message" : "Voice messages aren't supported in this browser"}
        title={supported ? "Hold to record" : "Voice messages aren't supported in this browser"}
        data-testid="voice-record"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          // keyboard: Enter / Space starts a hands-free (locked) recording
          if ((e.key === "Enter" || e.key === " ") && phase === "idle" && supported) {
            e.preventDefault();
            setRect((btn.current?.closest("form") ?? btn.current?.parentElement)?.getBoundingClientRect() ?? null);
            void begin(true);
          }
        }}
        className={cn(
          "relative flex shrink-0 touch-none items-center justify-center rounded-full transition select-none [-webkit-touch-callout:none]",
          size,
          active ? "z-[61] scale-125 bg-red-500 text-white" : supported ? "bg-zinc-800 text-zinc-300 hover:text-zinc-100" : "bg-zinc-800 text-zinc-600",
          disabled && "opacity-40",
        )}
        style={active && phase === "recording" ? { transform: `translate(${drag.dx * 0.25}px, ${drag.dy * 0.4}px) scale(1.25)` } : undefined}
      >
        <Mic className="h-[19px] w-[19px]" />
        {hint && <span className="pointer-events-none absolute right-0 bottom-12 z-10 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[12px] whitespace-nowrap text-zinc-100 shadow-lg ring-1 ring-white/10">{hint}</span>}
      </button>
      {active &&
        rect &&
        createPortal(
          <div
            className="fixed z-[60] flex items-center gap-3 rounded-2xl bg-zinc-950 px-3 text-zinc-100"
            style={{ left: rect.left, top: rect.top, width: rect.width - (compact ? 46 : 50), height: rect.height }}
            data-testid="voice-recording"
          >
            {phase === "locked" ? (
              <button type="button" onClick={() => finish(false)} aria-label="Delete recording" className="rounded-full p-2 text-red-400 hover:bg-white/5">
                <Trash2 className="h-5 w-5" />
              </button>
            ) : (
              <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500 motion-reduce:animate-none" />
            )}
            <span className="w-11 shrink-0 text-[14px] tabular-nums">{formatDuration(elapsed)}</span>
            <div ref={bars} className="flex h-6 min-w-0 flex-1 items-center gap-[2px] overflow-hidden" aria-hidden>
              {Array.from({ length: 36 }, (_, i) => (
                <span key={i} className="h-full w-[3px] origin-center scale-y-[0.12] rounded-full bg-red-400 transition-transform duration-75" />
              ))}
            </div>
            {phase === "recording" ? (
              <span className="flex shrink-0 items-center gap-1 text-[13px] text-zinc-400" style={{ transform: `translateX(${drag.dx * 0.6}px)`, opacity: 1 + drag.dx / CANCEL_PX }}>
                <ChevronLeft className="h-4 w-4" /> Slide to cancel
              </span>
            ) : (
              <button type="button" onClick={() => finish(true)} aria-label="Send voice message" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-on-accent">
                <SendHorizontal className="h-4 w-4" />
              </button>
            )}
          </div>,
          document.body,
        )}
      {phase === "recording" &&
        rect &&
        createPortal(
          <div
            className="fixed z-[60] flex w-9 flex-col items-center gap-1 rounded-full bg-zinc-900 py-2 text-zinc-300 shadow-lg ring-1 ring-white/10"
            style={{ left: rect.right - (compact ? 37 : 39), top: rect.top - 92 + Math.max(-LOCK_PX, drag.dy) * 0.5 }}
            aria-hidden
          >
            <Lock className="h-4 w-4" />
            <ChevronUp className="h-4 w-4 animate-bounce motion-reduce:animate-none" />
          </div>,
          document.body,
        )}
    </>
  );
}
