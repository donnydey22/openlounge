"use client";

// Telegram-style call UI: incoming (blurred avatar, Accept pulse / Decline / Message), outgoing (Calling… →
// Ringing…), in-call audio + video (draggable self-view PiP that snaps to corners, tap to swap), weak connection +
// reconnecting banners, call timer, and the minimized green bar.
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Mic, MicOff, MessageCircle, Phone, PhoneOff, RefreshCw, Video, VideoOff, X } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { useApp } from "@/components/AppProvider";
import { callEngine, fmt, type CallSnapshot } from "@/lib/calls/engine";
import { nativeMediaCmd } from "@/lib/calls/nativeMediaSession";
import { holdFrames, mirrorBackdrop } from "@/lib/calls/frameHold";
import { cn } from "@/lib/utils";
import { useCall } from "./useCall";
import { AudioRouteButton, RouteNotice } from "./AudioRouteButton";
import css from "./calls.module.css";

const QUICK_REPLIES = ["Can't talk now. What's up?", "I'll call you right back.", "I'll call you later.", "Can't talk now. Call me later?"];

// Transparent 1x1 GIF. Without a poster, Android WebView paints its default gray "play" poster until the first
// frame decodes (~1 s blip). A transparent poster suppresses that; nothing is ever visible.
const NO_POSTER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function useTicker(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const iv = setInterval(() => set((x) => x + 1), 1000);
    return () => clearInterval(iv);
  }, [on]);
}

function peerOf(s: CallSnapshot) {
  const c = s.call!;
  return s.role === "caller" ? c.callee : c.caller;
}

function statusText(s: CallSnapshot) {
  const c = s.call!;
  if (s.ui === "ended") return s.endedText ?? "Call ended";
  // reconnecting mid-call: the timer keeps running (banner says "Reconnecting…"); before connect, say it here
  if (s.reconnecting && !s.connectedAt) return "Reconnecting…";
  if (s.ui === "incoming") return `Open Lounge ${c.video ? "video" : "audio"} call`;
  if (s.ui === "outgoing") return c.phase === "ringing" ? "Ringing…" : c.id ? "Calling…" : "Requesting…";
  if (s.ui === "connecting") return "Connecting…";
  return s.connectedAt ? fmt(Math.max(0, Math.round((Date.now() - s.connectedAt) / 1000))) : "Connecting…";
}

function Bars({ q }: { q: CallSnapshot["quality"] }) {
  const n = q === "excellent" ? 4 : q === "good" ? 3 : q === "poor" ? 2 : q === "lost" ? 1 : 0;
  if (!n) return null;
  return (
    <span className="inline-flex items-end gap-[2px]" aria-label={`Connection ${q}`} role="img">
      {[1, 2, 3, 4].map((i) => (
        <span key={i} className={cn("w-[3px] rounded-sm", i <= n ? (n <= 2 ? "bg-amber-300" : "bg-white") : "bg-white/30")} style={{ height: 3 + i * 3 }} />
      ))}
    </span>
  );
}

function RoundBtn({ label, onClick, active, danger, children, big, testId, disabled }: { label: string; onClick: () => void; active?: boolean; danger?: boolean; children: React.ReactNode; big?: boolean; testId?: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} data-testid={testId} aria-label={label} aria-pressed={active} className={cn("flex min-w-0 flex-col items-center gap-1.5 disabled:opacity-40", css.btn)}>
      <span
        className={cn(
          "grid place-items-center rounded-full backdrop-blur-md",
          big ? "h-[68px] w-[68px] max-[340px]:h-14 max-[340px]:w-14" : "h-14 w-14 max-[340px]:h-12 max-[340px]:w-12",
          danger ? "bg-red-500 text-white" : active ? "bg-white text-zinc-900" : "bg-white/15 text-white",
        )}
      >
        {children}
      </span>
      <span className="max-w-[76px] truncate text-[12px] font-medium text-white/85 [@media(max-height:480px)]:hidden">{label}</span>
    </button>
  );
}

function Background({ s }: { s: CallSnapshot }) {
  const p = peerOf(s);
  return (
    <div className="absolute inset-0" aria-hidden>
      <div className={css.blob + " " + css.blobA} style={{ background: p.color }} />
      <div className={css.blob + " " + css.blobB} style={{ background: "#6366f1" }} />
      {p.photoUrl && <div className={css.bgPhoto} style={{ backgroundImage: `url(${JSON.stringify(p.photoUrl).slice(1, -1)})` }} />}
      <div className={css.shade} />
    </div>
  );
}

/** Self-view: draggable, snaps to the nearest corner, tap swaps big/small. */
function Pip({ which, onSwap, mirrored, tileRef, onTileChanged }: { which: "local" | "remote"; onSwap: () => void; mirrored: boolean; tileRef?: React.MutableRefObject<HTMLDivElement | null>; onTileChanged?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const vid = useRef<HTMLVideoElement>(null);
  const hold = useRef<HTMLCanvasElement>(null);
  const [aspectRatio, setAspectRatio] = useState(16 / 9);
  const [corner, setCorner] = useState<"tl" | "tr" | "bl" | "br">("tr");
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ px: number; py: number; moved: boolean } | null>(null);
  useEffect(() => {
    const el = vid.current;
    callEngine.attachVideo(which, el);
    const release = el && hold.current ? holdFrames(el, hold.current) : () => {};
    const syncAspect = () => {
      const width = el?.videoWidth ?? 0;
      const height = el?.videoHeight ?? 0;
      // Never force a phone frame into the viewport's aspect ratio: use the decoded feed's native geometry.
      if (width > 0 && height > 0) setAspectRatio(width / height);
    };
    el?.addEventListener("loadedmetadata", syncAspect);
    el?.addEventListener("resize", syncAspect);
    window.addEventListener("resize", syncAspect);
    syncAspect();
    return () => {
      el?.removeEventListener("loadedmetadata", syncAspect);
      el?.removeEventListener("resize", syncAspect);
      window.removeEventListener("resize", syncAspect);
      release();
      callEngine.attachVideo(which, null);
    };
  }, [which]);
  const M = 12;
  const bounds = () => {
    const w = ref.current?.offsetWidth ?? 100;
    const h = ref.current?.offsetHeight ?? 140;
    // WebKit's innerWidth can include its transient mobile visual viewport while the fixed call screen is laid out
    // against documentElement. Use the layout viewport so the PiP stays inside the rendered screen.
    const W = document.documentElement.clientWidth || window.innerWidth;
    const H = document.documentElement.clientHeight || window.innerHeight;
    const top = 64;
    const bottom = 150;
    return { w, h, W, H, minX: M, maxX: Math.max(M, W - w - M), minY: top, maxY: Math.max(top, H - h - bottom) };
  };
  const pos = (c: typeof corner) => {
    const { w, h, W, H } = bounds();
    const top = 64;
    const bottom = 150;
    return { x: c.endsWith("l") ? M : W - w - M, y: c.startsWith("t") ? top : H - h - bottom };
  };
  const [, force] = useState(0);
  useEffect(() => {
    const r = () => force((x) => x + 1);
    // iOS/WebKit can report a provisional visual viewport during the first render. Recompute after layout so a
    // portrait self-view is never positioned beyond the right edge before a resize event arrives.
    r();
    const frame = requestAnimationFrame(r);
    const settled = setTimeout(r, 250);
    const viewport = window.visualViewport;
    window.addEventListener("resize", r);
    window.addEventListener("orientationchange", r);
    viewport?.addEventListener("resize", r);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settled);
      window.removeEventListener("resize", r);
      window.removeEventListener("orientationchange", r);
      viewport?.removeEventListener("resize", r);
    };
  }, []);
  const p = drag ?? (typeof window !== "undefined" ? pos(corner) : { x: 0, y: 0 });
  useEffect(() => { const id = requestAnimationFrame(() => onTileChanged?.()); return () => cancelAnimationFrame(id); }, [p.x, p.y, aspectRatio, onTileChanged]);
  return (
    <div
      ref={(el) => { ref.current = el; if (tileRef) tileRef.current = el; }}
      className={cn(css.pip, "w-36 max-h-[38vh] max-w-[40vw] overflow-hidden max-[340px]:w-28 [@media(max-height:480px)]:w-32 bg-zinc-950", drag && css.pipDragging)}
      style={{ transform: `translate3d(${p.x}px, ${p.y}px, 0)`, left: 0, top: 0, aspectRatio }}
      data-testid="call-pip"
      onPointerDown={(e) => {
        try {
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        } catch {
          /* synthetic / already-released pointer */
        }
        const cur = pos(corner);
        start.current = { px: e.clientX - cur.x, py: e.clientY - cur.y, moved: false };
      }}
      onPointerMove={(e) => {
        const st = start.current;
        if (!st) return;
        const x = e.clientX - st.px;
        const y = e.clientY - st.py;
        const cur = pos(corner);
        if (!st.moved && Math.hypot(x - cur.x, y - cur.y) < 6) return;
        st.moved = true;
        // Keep the page PiP and its app-owned RTCView on the same fully visible rectangle while dragging.
        const b = bounds();
        setDrag({ x: Math.max(b.minX, Math.min(b.maxX, x)), y: Math.max(b.minY, Math.min(b.maxY, y)) });
      }}
      onPointerUp={(e) => {
        const st = start.current;
        start.current = null;
        if (!st?.moved) {
          setDrag(null);
          onSwap();
          return;
        }
        const { W, H } = bounds();
        const cx = e.clientX;
        const cy = e.clientY;
        setCorner(`${cy < H / 2 ? "t" : "b"}${cx < W / 2 ? "l" : "r"}` as typeof corner);
        setDrag(null);
      }}
      onPointerCancel={() => {
        start.current = null;
        setDrag(null);
      }}
    >
      <video ref={vid} autoPlay playsInline muted poster={NO_POSTER} controls={false} disablePictureInPicture className={cn("relative z-[1] h-full w-full object-contain", css.callVideo)} style={{ transform: `${mirrored ? "scaleX(-1) " : ""}translateZ(0)` }} data-testid={`call-pip-video-${which}`} />
      <canvas ref={hold} aria-hidden className={cn("pointer-events-none absolute inset-0 z-[2] h-full w-full object-contain", css.holdFrame)} style={{ transform: `${mirrored ? "scaleX(-1) " : ""}translateZ(0)` }} data-testid={`call-pip-hold-${which}`} />
    </div>
  );
}

function BigVideo({ which, mirrored, tileRef }: { which: "local" | "remote"; mirrored: boolean; tileRef?: React.MutableRefObject<HTMLDivElement | null> }) {
  const vid = useRef<HTMLVideoElement>(null);
  const hold = useRef<HTMLCanvasElement>(null);
  const back = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = vid.current;
    callEngine.attachVideo(which, el);
    const release = el && hold.current ? holdFrames(el, hold.current) : () => {};
    const stopBackdrop = el && back.current ? mirrorBackdrop(el, back.current) : () => {};
    return () => {
      stopBackdrop();
      release();
      callEngine.attachVideo(which, null);
    };
  }, [which]);
  // Phones: cover edge to edge (no backdrop). Tablets/desktop: contain over a blurred copy of the same stream.
  const flip = mirrored ? "-scale-x-100" : undefined;
  return (
    <div ref={(el) => { if (tileRef) tileRef.current = el; }} className={css.videoStage} data-testid="call-video-stage">
      <video ref={back} aria-hidden autoPlay playsInline muted poster={NO_POSTER} controls={false} disablePictureInPicture tabIndex={-1} className={cn(css.stageBackdrop, flip)} data-testid={`call-backdrop-${which}`} />
      <video ref={vid} autoPlay playsInline muted poster={NO_POSTER} controls={false} disablePictureInPicture className={cn(css.stageVideo, css.callVideo, flip)} style={{ zIndex: 1 }} data-testid={`call-video-${which}`} />
      <canvas ref={hold} aria-hidden className={cn(css.stageVideo, css.holdFrame, flip)} data-testid={`call-hold-${which}`} />
    </div>
  );
}

function Incoming({ s }: { s: CallSnapshot }) {
  const [replies, setReplies] = useState(false);
  const [dragY, setDragY] = useState(0);
  // Optimistic + idempotent: the first press wins, both buttons lock instantly (no double accept / accept+decline race).
  const [pending, setPending] = useState<"accept" | "decline" | null>(null);
  const acted = useRef(false);
  const startY = useRef<number | null>(null);
  const c = s.call!;
  // a failed accept returns the card to "incoming" (engine): unlock so the user can retry
  useEffect(() => {
    acted.current = false;
    setPending(null);
  }, [c.id, s.error]);
  const act = (kind: "accept" | "decline") => {
    if (acted.current) return;
    acted.current = true;
    setPending(kind);
    void (kind === "accept" ? callEngine.accept(c.video) : callEngine.decline());
  };
  const tap = { touchAction: "manipulation" as const };
  return (
    <>
      {s.error && <p role="alert" data-testid="call-incoming-error" className="mb-2 px-6 text-center text-[13px] text-red-300">{s.error}</p>}
      <div className="flex w-full items-end justify-around px-6 pb-2" aria-busy={pending ? true : undefined}>
        <div className="flex flex-col items-center gap-2">
          <button type="button" data-testid="call-decline" aria-label="Decline" disabled={!!pending} onClick={() => act("decline")} style={tap} className={cn("grid h-[72px] w-[72px] place-items-center rounded-full bg-red-500 text-white shadow-lg shadow-red-900/40 disabled:opacity-60", css.btn, pending === "decline" && css.pressed)}>
            <PhoneOff className="h-8 w-8" />
          </button>
          <span className="text-[13px] font-medium text-white/85">{pending === "decline" ? "Declining…" : "Decline"}</span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <button type="button" data-testid="call-message" aria-label="Message" disabled={!!pending} onClick={() => setReplies(true)} style={tap} className={cn("grid h-16 w-16 place-items-center rounded-full bg-white/15 text-white backdrop-blur-md disabled:opacity-60", css.btn)}>
            <MessageCircle className="h-6 w-6" />
          </button>
          <span className="text-[12px] font-medium text-white/70">Message</span>
        </div>
        <div className="flex flex-col items-center gap-2">
          <span className={cn("text-[11px] text-white/60 [@media(max-height:560px)]:hidden", css.swipeHint)} aria-hidden>
            swipe up
          </span>
          <button
            type="button"
            data-testid="call-accept"
            aria-label={c.video ? "Accept video call" : "Accept"}
            disabled={!!pending}
            onClick={() => act("accept")}
            onPointerDown={(e) => (startY.current = e.clientY)}
            onPointerMove={(e) => startY.current !== null && setDragY(Math.min(0, e.clientY - startY.current))}
            onPointerUp={() => {
              // a swipe accepts on release; a plain tap is handled once by onClick (act() is idempotent either way)
              if (dragY < -60) act("accept");
              startY.current = null;
              setDragY(0);
            }}
            onPointerCancel={() => ((startY.current = null), setDragY(0))}
            style={{ transform: dragY ? `translateY(${Math.max(-120, dragY)}px)` : undefined, touchAction: "none" }}
            className={cn("isolate grid h-[72px] w-[72px] place-items-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-900/40 disabled:opacity-90", !dragY && !pending && css.accept, pending === "accept" && css.pressed)}
          >
            {c.video ? <Video className="h-8 w-8" /> : <Phone className="h-8 w-8" />}
          </button>
          <span className="text-[13px] font-medium text-white/85" data-testid="call-accept-label">{pending === "accept" ? "Connecting…" : "Accept"}</span>
        </div>
      </div>
      {replies && (
        <div className="absolute inset-0 z-10 flex items-end bg-black/40" onClick={() => setReplies(false)}>
          <div className={cn("w-full rounded-t-3xl bg-zinc-900/95 p-3 pb-[calc(env(safe-area-inset-bottom)+12px)] backdrop-blur-xl", css.fadeUp)} onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/20" />
            {QUICK_REPLIES.map((t) => (
              <button key={t} type="button" onClick={() => void callEngine.decline(t)} className="block w-full rounded-xl px-4 py-3 text-left text-[15px] text-white hover:bg-white/10">
                {t}
              </button>
            ))}
            <button type="button" onClick={() => setReplies(false)} className="mt-1 block w-full rounded-xl px-4 py-3 text-center text-[15px] font-semibold text-emerald-400 hover:bg-white/10">
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function Controls({ s }: { s: CallSnapshot }) {
  return (
    <div className="flex w-full max-w-md items-start justify-center gap-2 px-4 max-[340px]:gap-1 max-[340px]:px-2 [&>*]:flex-1 [&>*]:max-w-[calc((100%-1.5rem)/4)] max-[340px]:[&>*]:max-w-[calc((100%-0.75rem)/4)]">
      {s.speakerSupported ? <AudioRouteButton s={s} Btn={RoundBtn} /> : null}
      {s.camOn ? (
        <RoundBtn label="Flip" onClick={() => void callEngine.flip()} testId="call-flip">
          <RefreshCw className="h-6 w-6" />
        </RoundBtn>
      ) : null}
      {/* Native voice calls retain their audio-only policy; the separately granted iPhone video path keeps normal camera controls. */}
      {s.nativeAudio && !s.nativeVideo ? null : (
        <RoundBtn label={s.camOn ? "Stop video" : "Video"} active={s.camOn} onClick={() => void callEngine.toggleCam()} testId="call-video">
          {s.camOn ? <Video className="h-6 w-6" /> : <VideoOff className="h-6 w-6" />}
        </RoundBtn>
      )}
      <RoundBtn label={s.muted ? "Unmute" : "Mute"} active={s.muted} onClick={() => void callEngine.toggleMute()} testId="call-mute">
        {s.muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
      </RoundBtn>
      <RoundBtn label="End call" danger onClick={() => void callEngine.hangup()} testId="call-end">
        <PhoneOff className="h-6 w-6" />
      </RoundBtn>
    </div>
  );
}

function MiniBar({ s }: { s: CallSnapshot }) {
  const p = peerOf(s);
  useEffect(() => {
    const html = document.documentElement;
    html.setAttribute("data-call-bar", "");
    return () => html.removeAttribute("data-call-bar");
  }, []);
  return (
    <button type="button" data-testid="call-bar" onClick={() => callEngine.setMinimized(false)} className={cn(css.bar, "flex w-full items-center justify-center gap-2 bg-emerald-500 px-4 text-[13px] font-semibold text-white")}>
      <span className="flex h-7 min-w-0 items-center gap-2">
        <span className={cn("h-2 w-2 shrink-0 rounded-full bg-white", css.barDot)} />
        <span className="truncate">{p.name}</span>
        <span className="shrink-0 tabular-nums opacity-90">{statusText(s)}</span>
        <span className="shrink-0 opacity-80 max-[340px]:hidden">· Tap to return</span>
      </span>
    </button>
  );
}

export function CallOverlay() {
  const s = useCall();
  const active = s.ui === "active" || s.ui === "connecting";
  useTicker(!!s.ui && s.ui !== "ended");
  const [swap, setSwap] = useState(false);
  const [showCtl, setShowCtl] = useState(true);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const video = active && (s.remoteCam || s.camOn);
  const poke = useCallback(() => {
    setShowCtl(true);
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(() => setShowCtl(false), 4000);
  }, []);
  useEffect(() => {
    if (!video) setShowCtl(true);
    else poke();
    return () => {
      if (idle.current) clearTimeout(idle.current);
    };
  }, [video, poke]);
  // Escape minimizes; the system back gesture shouldn't silently leave a call screen half-open
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && active && callEngine.setMinimized(true);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [active]);

  const bigWhich: "local" | "remote" = s.remoteCam && s.camOn ? (swap ? "local" : "remote") : s.remoteCam ? "remote" : "local";
  const showPip = s.remoteCam && s.camOn;
  const ctlHidden = video && !showCtl;
  const bigTile = useRef<HTMLDivElement | null>(null);
  const pipTile = useRef<HTMLDivElement | null>(null);
  const reportNativeLayout = useCallback(() => {
    if (!s.nativeVideo || !s.call) return;
    const hidden = s.minimized || !video;
    if (hidden) {
      // BigVideo unmounts in these states, so the native stage must receive a valid hidden-only record.
      void nativeMediaCmd({ op: "videoLayout", version: 1, callId: s.call.id, hidden: true }).catch(() => {});
      return;
    }
    // Both full-screen and PiP rectangles are normalized against the actual fixed call stage, never a mix of
    // layout-, visual-, and browser viewport values. App.tsx maps this same unit space into the WebView frame.
    const stage = bigTile.current?.getBoundingClientRect();
    if (!stage || ![stage.left, stage.top, stage.width, stage.height].every(Number.isFinite) || stage.width <= 0 || stage.height <= 0) return;
    const rect = (el: HTMLDivElement | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (![r.left, r.top, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) return null;
      const left = Math.max(stage.left, r.left);
      const top = Math.max(stage.top, r.top);
      const right = Math.min(stage.right, r.right);
      const bottom = Math.min(stage.bottom, r.bottom);
      if (right <= left || bottom <= top) return null;
      return { x: (left - stage.left) / stage.width, y: (top - stage.top) / stage.height, width: (right - left) / stage.width, height: (bottom - top) / stage.height };
    };
    const big = rect(bigTile.current);
    if (!big) return;
    const pip = showPip ? rect(pipTile.current) : null;
    // The app-owned iPhone call surface is phone-only. Keep its remote full tile aspect-filled exactly as this overlay
    // renders on phones; the native renderer preserves aspect ratio (no stretch) and the local PiP is cover as well.
    void nativeMediaCmd({ op: "videoLayout", version: 1, callId: s.call.id, hidden: false, viewport: { width: stage.width, height: stage.height, keyboard: Math.max(0, stage.height - (window.visualViewport?.height ?? stage.height)) }, big: { kind: bigWhich, rect: big, fit: "cover" }, pip: pip ? { kind: bigWhich === "local" ? "remote" : "local", rect: pip, fit: "cover", mirror: bigWhich === "remote" && s.facing === "user" } : null }).catch(() => {});
  }, [bigWhich, s.call, s.facing, s.minimized, s.nativeVideo, showPip, video]);
  useEffect(() => {
    if (!s.nativeVideo || !s.call) return;
    const notify = () => requestAnimationFrame(reportNativeLayout);
    notify();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(notify);
    if (bigTile.current) observer?.observe(bigTile.current);
    if (pipTile.current) observer?.observe(pipTile.current);
    window.addEventListener("resize", notify);
    window.addEventListener("orientationchange", notify);
    window.visualViewport?.addEventListener("resize", notify);
    window.visualViewport?.addEventListener("scroll", notify);
    return () => { observer?.disconnect(); window.removeEventListener("resize", notify); window.removeEventListener("orientationchange", notify); window.visualViewport?.removeEventListener("resize", notify); window.visualViewport?.removeEventListener("scroll", notify); };
  }, [reportNativeLayout, s.call, s.nativeVideo]);

  if (!s.ui && s.elsewhere) return <ElsewherePill e={s.elsewhere} />;
  if (!s.ui || !s.call) return null;
  if (s.minimized && s.ui !== "incoming" && s.ui !== "ended") return <MiniBar s={s} />;
  const p = peerOf(s);
  const ringing = s.ui === "outgoing" || s.ui === "incoming";
  const nativeFullscreen = s.nativeVideo && !s.minimized && (s.ui === "connecting" || s.ui === "active") && video;

  return (
    <div className={cn(css.screen, nativeFullscreen && css.nativeVideoScreen)} role="dialog" aria-modal="true" aria-label={`Call with ${p.name}`} data-testid="call-screen" data-ui={s.ui} onPointerDown={video ? poke : undefined}>
      {video ? <BigVideo which={bigWhich} mirrored={bigWhich === "local" && s.facing === "user"} tileRef={bigTile} /> : <Background s={s} />}
      {showPip && <Pip which={bigWhich === "local" ? "remote" : "local"} mirrored={bigWhich === "remote" && s.facing === "user"} onSwap={() => setSwap((x) => !x)} tileRef={pipTile} onTileChanged={reportNativeLayout} />}

      <div className="relative z-[6] flex h-full flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
        {/* top bar */}
        <div className={cn("flex h-14 shrink-0 items-center justify-between px-3", css.controls, ctlHidden && css.controlsHidden)}>
          {s.ui !== "incoming" && s.ui !== "ended" ? (
            <button type="button" onClick={() => callEngine.setMinimized(true)} aria-label="Minimize call" data-testid="call-minimize" className={cn("grid h-10 w-10 place-items-center rounded-full bg-white/10 backdrop-blur-md", css.btn)}>
              <ChevronDown className="h-6 w-6" />
            </button>
          ) : (
            <span />
          )}
          <span className="flex items-center gap-2 text-xs font-medium text-white/80">
            {active && <Bars q={s.quality} />}
          </span>
          {s.ui === "ended" ? (
            <button type="button" onClick={() => callEngine.dismiss()} aria-label="Close" className={cn("grid h-10 w-10 place-items-center rounded-full bg-white/10", css.btn)}>
              <X className="h-5 w-5" />
            </button>
          ) : (
            <span className="w-10" />
          )}
        </div>

        {/* banners */}
        <div className="pointer-events-none flex flex-col items-center gap-2 px-4">
          {s.reconnecting && (
            <div className={cn("rounded-full bg-black/50 px-3 py-1 text-xs font-semibold backdrop-blur-md", css.banner)} data-testid="call-reconnecting">
              Reconnecting…
            </div>
          )}
          {!s.reconnecting && s.peerReconnecting && active && (
            <div className={cn("rounded-full bg-black/50 px-3 py-1 text-xs font-semibold backdrop-blur-md", css.banner)} data-testid="call-peer-reconnecting">
              {p.name.split(" ")[0]} is reconnecting…
            </div>
          )}
          {!s.reconnecting && !s.peerReconnecting && active && (s.quality === "poor" || s.quality === "lost") && (
            <div className={cn("rounded-full bg-amber-500/90 px-3 py-1 text-xs font-semibold text-black", css.banner)} data-testid="call-weak">
              Weak connection
            </div>
          )}
          {s.needsGesture && active && (
            <button type="button" onClick={() => void callEngine.startAudio()} className="pointer-events-auto rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-zinc-900">
              Tap to hear {p.name.split(" ")[0]}
            </button>
          )}
          {s.error && (
            <button type="button" onClick={() => callEngine.clearError()} className={cn("pointer-events-auto max-w-sm rounded-2xl bg-black/60 px-3 py-1.5 text-center text-xs backdrop-blur-md", css.banner)}>
              {s.error}
            </button>
          )}
          {s.videoInvite && !s.camOn && !(s.nativeAudio && !s.nativeVideo) && active && (
            <div className={cn("pointer-events-auto flex items-center gap-2 rounded-full bg-black/55 py-1 pr-1 pl-3 text-xs backdrop-blur-md", css.banner)}>
              {p.name.split(" ")[0]} turned on video
              <button type="button" onClick={() => void callEngine.toggleCam()} className="rounded-full bg-white px-3 py-1 font-semibold text-zinc-900">
                Turn on mine
              </button>
              <button type="button" onClick={() => callEngine.dismissVideoInvite()} aria-label="Dismiss" className="p-1 text-white/70">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* center: avatar, name, status */}
        <div className={cn("flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center", video && "justify-start pt-2", css.controls, ctlHidden && css.controlsHidden)}>
          {!video && (
            <div className={cn(css.rings, "[@media(max-height:560px)]:scale-75")}>
              {ringing && (
                <>
                  <span className={css.ring} />
                  <span className={css.ring} />
                  <span className={css.ring} />
                </>
              )}
              <PresenceAvatar p={p} />
            </div>
          )}
          <div className={cn("min-w-0 max-w-full", css.fadeUp)}>
            <div className={cn("truncate font-semibold tracking-tight", video ? "text-xl drop-shadow" : "text-[28px] leading-tight max-[340px]:text-2xl")} data-testid="call-name">
              {p.name}
            </div>
            <div className="mt-1 flex items-center justify-center gap-2 text-[15px] text-white/80 tabular-nums drop-shadow" data-testid="call-status">
              {statusText(s)}
              {s.remoteMuted && active && <MicOff className="h-4 w-4" aria-label="Muted" />}
            </div>
          </div>
        </div>

        {/* bottom */}
        <div className={cn("flex shrink-0 flex-col items-center gap-4 pb-6 [@media(max-height:480px)]:pb-2", css.controls, ctlHidden && css.controlsHidden)}>
          {s.ui === "incoming" ? (
            <Incoming s={s} />
          ) : s.ui === "ended" ? (
            s.canRetry ? (
              <div className={cn("flex items-start gap-10", css.fadeUp)}>
                <RoundBtn label="Cancel" onClick={() => callEngine.dismiss()} testId="call-close">
                  <X className="h-6 w-6" />
                </RoundBtn>
                <RoundBtn label="Call again" onClick={() => callEngine.retry()} testId="call-retry">
                  <Phone className="h-6 w-6 text-emerald-300" />
                </RoundBtn>
              </div>
            ) : (
              <div className="h-14" />
            )
          ) : (
            <>
              <RouteNotice text={s.routeNotice} />
              <Controls s={s} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Same account, call running on another device: quiet pill, no ring, no audio, no controls that grab media. */
function ElsewherePill({ e }: { e: NonNullable<CallSnapshot["elsewhere"]> }) {
  useTicker(true);
  const sec = Math.max(0, Math.floor((Date.now() - e.since) / 1000));
  return (
    <div
      data-testid="call-elsewhere"
      role="status"
      aria-live="polite"
      style={{ position: "fixed", top: "calc(env(safe-area-inset-top, 0px) + 8px)", left: "50%", transform: "translateX(-50%)", zIndex: 60, background: "#10B981", color: "#fff", borderRadius: 999, padding: "6px 14px", fontSize: 13, fontWeight: 600, boxShadow: "0 2px 10px rgba(0,0,0,.25)", pointerEvents: "none", whiteSpace: "nowrap" }}
    >
      {e.video ? "Video call" : "On a call"} with {e.peerName} on another device · {fmt(sec)}
    </div>
  );
}

/** Call screen avatar with the same live presence dot as everywhere else (green online / amber idle). */
function PresenceAvatar({ p }: { p: { id?: string; name: string; color: string; photoUrl: string | null } }) {
  const { presenceOf } = useApp();
  const st = p.id ? presenceOf(p.id) : "offline";
  return <Avatar name={p.name} color={p.color} photo={p.photoUrl} size="xl" presence={st === "offline" ? null : (st as "online" | "away")} />;
}
