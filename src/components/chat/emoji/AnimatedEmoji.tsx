"use client";

// One animated emoji, from whichever source assets.ts picks (Telegram WebP by default, Noto Lottie as fallback).
//
// Modes:  loop   — plays continuously while on screen (reaction bar)
//         once   — plays one cycle when it first scrolls into view (or on `replay` bumps), then rests on its poster
//         hover  — poster until hovered / pressed, then loops (picker grid)
//         static — poster only (chips, tiny sizes)
// Off-screen emoji never decode: a shared IntersectionObserver swaps them to the poster (WebP) or pauses (Lottie).
// The poster is always painted underneath, so there's no flash while the animation decodes. Reduced motion → posters.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { assetChain, FALLBACK_TIMEOUT_MS, noteAssetFailure, REMOTE_TIMEOUT_MS, resolveRemote, type EmojiAsset, type EmojiSource } from "@/lib/emoji/assets";
import { cn } from "@/lib/utils";

export type EmojiMode = "loop" | "once" | "hover" | "static";

// ---- shared visibility observer ----
const watchers = new Map<Element, (visible: boolean) => void>();
let io: IntersectionObserver | null = null;
function observe(el: Element, cb: (visible: boolean) => void) {
  if (typeof IntersectionObserver === "undefined") {
    cb(true);
    return () => {};
  }
  io ??= new IntersectionObserver((entries) => {
    for (const e of entries) watchers.get(e.target)?.(e.isIntersecting);
  }, { rootMargin: "160px" });
  watchers.set(el, cb);
  io.observe(el);
  return () => {
    watchers.delete(el);
    io?.unobserve(el);
  };
}

// ---- blob cache: one download per animation; each replay gets a fresh object URL so the decoder restarts at frame 0 ----
const blobs = new Map<string, Promise<Blob>>();
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout")), ms);
    p.then((v) => (clearTimeout(t), res(v)), (e) => (clearTimeout(t), rej(e)));
  });
}
function blobOf(src: string, ms: number) {
  let p = blobs.get(src);
  if (!p) {
    p = withTimeout(
      fetch(src).then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.blob();
      }),
      ms,
    );
    p.catch(() => blobs.delete(src));
    blobs.set(src, p);
  }
  return p;
}

// ---- lottie (Noto) — lazy, only when a Lottie emoji renders ----
type LottieAnim = { play(): void; pause(): void; stop(): void; goToAndStop(v: number, f?: boolean): void; goToAndPlay(v: number, f?: boolean): void; destroy(): void; setLoop?(l: boolean): void; loop: boolean | number; addEventListener(n: string, cb: () => void): void };
type LottiePlayer = { loadAnimation(o: Record<string, unknown>): LottieAnim };
let lottieP: Promise<LottiePlayer> | null = null;
const loadLottie = () =>
  (lottieP ??= import("lottie-web/build/player/esm/lottie_light_canvas.min.js").then((m) => (m as unknown as { default: LottiePlayer }).default));
const jsons = new Map<string, Promise<unknown>>();
const jsonOf = (src: string) => {
  let p = jsons.get(src);
  if (!p) {
    p = fetch(src).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
    p.catch(() => jsons.delete(src));
    jsons.set(src, p);
  }
  return p;
};

let reduced: boolean | null = null;
export function prefersReducedMotion() {
  if (reduced === null && typeof window !== "undefined") {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    reduced = !!mq?.matches;
    mq?.addEventListener?.("change", (e) => (reduced = e.matches));
  }
  return !!reduced;
}

function Glyph({ emoji, size, className }: { emoji: string; size: number; className?: string }) {
  return (
    <span
      className={cn("inline-flex select-none items-center justify-center leading-none", className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.82) }}
      role="img"
      aria-label={emoji}
    >
      {emoji}
    </span>
  );
}

export const AnimatedEmoji = memo(function AnimatedEmoji({
  emoji,
  size,
  mode = "loop",
  replay = 0,
  source,
  className,
  autoPlay = true,
  onCycleEnd,
}: {
  emoji: string;
  size: number;
  mode?: EmojiMode;
  /** bump to replay a "once" emoji from the start */
  replay?: number;
  /** force a source (dev comparison); default = assets.ts preference */
  source?: EmojiSource;
  className?: string;
  /** "once": play when it first becomes visible (default) — false = wait for a replay bump */
  autoPlay?: boolean;
  onCycleEnd?: () => void;
}) {
  // fallback chain (assets.ts): our Telegram copy → upstream Telegram file → our Noto copy → native glyph
  const chain = useMemo(() => assetChain(emoji, source, mode !== "static"), [emoji, source, mode]);
  const [stage, setStage] = useState(0);
  const [resolved, setResolved] = useState<{ stage: number; asset: EmojiAsset | null } | null>(null);
  useEffect(() => setStage(0), [chain]);
  const step = chain[stage];
  useEffect(() => {
    if (step?.type !== "remote") return;
    let alive = true;
    resolveRemote(step)
      .then((a) => alive && (a ? setResolved({ stage, asset: a }) : setStage((s) => s + 1)))
      .catch(() => alive && setStage((s) => s + 1));
    return () => {
      alive = false;
    };
  }, [step, stage]);
  const asset: EmojiAsset | null | undefined = !step ? null : step.type === "remote" ? (resolved?.stage === stage ? resolved.asset : undefined) : step;
  const fail = useCallback(() => {
    if (step) noteAssetFailure(step);
    setStage((s) => s + 1);
  }, [step]);
  if (asset === null) return <Glyph emoji={emoji} size={size} className={className} />;
  // A remote-source probe or a cache retry must never leave a picker cell empty. The native glyph is the stable
  // first frame until the self-hosted poster/animation for this stage is ready (or the chain falls back again).
  if (asset === undefined) return <Glyph emoji={emoji} size={size} className={className} />;
  return asset.type === "webp" ? (
    <WebpEmoji key={stage} asset={asset} emoji={emoji} size={size} mode={mode} replay={replay} className={className} autoPlay={autoPlay} onCycleEnd={onCycleEnd} onBroken={fail} />
  ) : (
    <LottieEmoji key={stage} asset={asset} emoji={emoji} size={size} mode={mode} replay={replay} className={className} autoPlay={autoPlay} onCycleEnd={onCycleEnd} onBroken={fail} />
  );
});

type InnerProps = { asset: EmojiAsset; emoji: string; size: number; mode: EmojiMode; replay: number; className?: string; autoPlay: boolean; onCycleEnd?: () => void; onBroken: () => void };

function WebpEmoji({ asset, emoji, size, mode, replay, className, autoPlay, onCycleEnd, onBroken }: InnerProps) {
  const box = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [hover, setHover] = useState(false);
  const [onceUrl, setOnceUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const played = useRef(false);
  const endRef = useRef(onCycleEnd);
  endRef.current = onCycleEnd;
  const brokenRef = useRef(onBroken);
  brokenRef.current = onBroken;

  useEffect(() => (box.current ? observe(box.current, setVisible) : undefined), []);
  // grid cells (hover / static) fetch their poster only once scrolled near — browsers' native lazy margins are
  // far larger than a 300 px picker and would pull hundreds of posters
  const [seen, setSeen] = useState(false);
  if (visible && !seen) setSeen(true);
  const posterSrc = mode === "hover" || mode === "static" ? (seen ? asset.poster : null) : asset.poster;

  // "once": a fresh object URL per play (first visible, then every replay bump)
  // (the trigger must not flip when `played` is set, or the cleanup would revoke the URL mid-play while the image —
  // or the long-press overlay's snapshot of it — still needs it: net::ERR_FILE_NOT_FOUND)
  const trigger = mode === "once" && visible && (replay > 0 || autoPlay) ? replay : -1;
  useEffect(() => {
    if (trigger < 0 || prefersReducedMotion()) return;
    if (trigger === 0 && played.current) return;
    played.current = true;
    let url: string | null = null;
    let done: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    blobOf(asset.src, asset.remote ? REMOTE_TIMEOUT_MS : FALLBACK_TIMEOUT_MS)
      .then((b) => {
        if (cancelled) return;
        url = URL.createObjectURL(b);
        setLoaded(false);
        setOnceUrl(url);
        done = setTimeout(() => {
          setOnceUrl(null);
          const u = url!;
          url = null;
          setTimeout(() => URL.revokeObjectURL(u), 1000);
          endRef.current?.();
        }, Math.max(800, asset.durationMs));
      })
      .catch(() => !cancelled && brokenRef.current());
    return () => {
      cancelled = true;
      if (done) clearTimeout(done);
      if (url) {
        const u = url;
        setOnceUrl((cur) => (cur === u ? null : cur)); // stop showing it before it's revoked
        setTimeout(() => URL.revokeObjectURL(u), 1000);
      }
    };
  }, [trigger, asset.src, asset.durationMs]);

  const reducedNow = prefersReducedMotion();
  const animSrc =
    reducedNow || mode === "static" ? null : mode === "loop" ? (visible ? asset.src : null) : mode === "hover" ? (hover && visible ? asset.src : null) : onceUrl;

  // an animation that neither loads nor errors within the budget counts as failed → next source in the chain
  const loadedRef = useRef(false);
  loadedRef.current = loaded;
  const streamed = animSrc && !animSrc.startsWith("blob:") ? animSrc : null;
  useEffect(() => {
    if (!streamed) return;
    const t = setTimeout(() => !loadedRef.current && brokenRef.current(), asset.remote ? REMOTE_TIMEOUT_MS : FALLBACK_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [streamed, asset.remote]);

  return (
    <span
      ref={box}
      className={cn("relative inline-block shrink-0 select-none align-middle", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={emoji}
      onPointerEnter={mode === "hover" ? () => setHover(true) : undefined}
      onPointerLeave={mode === "hover" ? () => setHover(false) : undefined}
      onPointerDown={mode === "hover" ? () => setHover(true) : undefined}
      onPointerUp={mode === "hover" ? (e) => e.pointerType !== "mouse" && setHover(false) : undefined}
      onPointerCancel={mode === "hover" ? () => setHover(false) : undefined}
    >
      {/* The glyph is always painted first. Posters and decoded animation cover it, but a slow/failed fetch never
          produces an empty cell while the source chain moves to its next cached fallback. */}
      <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center leading-none" style={{ fontSize: Math.round(size * 0.82) }}>
        {emoji}
      </span>
      {asset.poster && posterSrc && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={posterSrc}
          alt=""
          draggable={false}
          decoding="async"
          loading={mode === "static" || mode === "hover" ? "lazy" : "eager"}
          width={size}
          height={size}
          className={cn("pointer-events-none absolute inset-0 h-full w-full", animSrc && loaded && "opacity-0")}
          onError={onBroken}
        />
      )}
      {animSrc && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={animSrc}
          src={animSrc}
          alt=""
          draggable={false}
          decoding="async"
          width={size}
          height={size}
          onLoad={() => setLoaded(true)}
          onError={onBroken}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
      )}
    </span>
  );
}

function LottieEmoji({ asset, emoji, size, mode, replay, className, autoPlay, onCycleEnd, onBroken }: InnerProps) {
  const box = useRef<HTMLSpanElement>(null);
  const holder = useRef<HTMLSpanElement>(null);
  const anim = useRef<LottieAnim | null>(null);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(false);
  const [hover, setHover] = useState(false);
  // Noto's frame 0 is often empty (things scale in): the poster (Google's still) shows whenever we're not playing
  const [playing, setPlaying] = useState(false);
  const played = useRef(false);
  const endRef = useRef(onCycleEnd);
  endRef.current = onCycleEnd;
  const brokenRef = useRef(onBroken);
  brokenRef.current = onBroken;

  useEffect(() => (box.current ? observe(box.current, setVisible) : undefined), []);
  // grid cells (hover / static) fetch their poster only once scrolled near — browsers' native lazy margins are
  // far larger than a 300 px picker and would pull hundreds of posters
  const [seen, setSeen] = useState(false);
  if (visible && !seen) setSeen(true);
  const posterSrc = mode === "hover" || mode === "static" ? (seen ? asset.poster : null) : asset.poster;

  // hover cells (picker grids) fetch their Lottie only once hovered / pressed — the poster covers the rest
  const needed = mode !== "static" && !prefersReducedMotion() && (ready || (mode === "hover" ? hover && visible : visible));
  useEffect(() => {
    if (!needed || anim.current) return;
    let alive = true;
    Promise.all([loadLottie(), withTimeout(jsonOf(asset.src), FALLBACK_TIMEOUT_MS)])
      .then(([lottie, data]) => {
        if (!alive || !holder.current) return;
        const a = lottie.loadAnimation({
          container: holder.current,
          renderer: "canvas",
          loop: mode === "loop" || mode === "hover",
          autoplay: false,
          animationData: data,
          rendererSettings: { clearCanvas: true, progressiveLoad: true, preserveAspectRatio: "xMidYMid meet" },
        });
        a.addEventListener("DOMLoaded", () => alive && setReady(true));
        a.addEventListener("complete", () => {
          a.goToAndStop(0, true);
          if (alive) setPlaying(false);
          endRef.current?.();
        });
        anim.current = a;
      })
      .catch(() => alive && brokenRef.current());
    return () => {
      alive = false;
    };
  }, [needed, asset.src, mode]);
  useEffect(() => () => anim.current?.destroy(), []);

  // drive playback
  useEffect(() => {
    const a = anim.current;
    if (!a || !ready) return;
    const on = mode === "loop" ? visible : mode === "hover" ? hover && visible : null;
    if (on === null) return;
    if (on) a.play();
    else if (mode === "loop") a.pause();
    else a.goToAndStop(0, true);
    setPlaying(on);
  }, [ready, visible, hover, mode]);
  useEffect(() => {
    const a = anim.current;
    if (!a || !ready || mode !== "once" || !visible) return;
    if (replay > 0 || (autoPlay && !played.current)) {
      played.current = true;
      a.goToAndPlay(0, true);
      setPlaying(true);
    }
  }, [ready, replay, mode, visible, autoPlay]);

  return (
    <span
      ref={box}
      className={cn("relative inline-block shrink-0 select-none align-middle", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={emoji}
      onPointerEnter={mode === "hover" ? () => setHover(true) : undefined}
      onPointerLeave={mode === "hover" ? () => setHover(false) : undefined}
      onPointerDown={mode === "hover" ? () => setHover(true) : undefined}
      onPointerUp={mode === "hover" ? (e) => e.pointerType !== "mouse" && setHover(false) : undefined}
      onPointerCancel={mode === "hover" ? () => setHover(false) : undefined}
    >
      {/* Same permanent first-frame fallback as WebP: keep an emoji visible while lazy poster/Lottie work starts. */}
      <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center leading-none" style={{ fontSize: Math.round(size * 0.82) }}>
        {emoji}
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={posterSrc ?? undefined}
        alt=""
        draggable={false}
        decoding="async"
        loading="lazy"
        className={cn("pointer-events-none absolute inset-0 h-full w-full", ready && playing && "opacity-0")}
        onError={onBroken}
      />
      <span ref={holder} className={cn("pointer-events-none absolute inset-0 [&>canvas]:!h-full [&>canvas]:!w-full", !playing && "opacity-0")} />
    </span>
  );
}
