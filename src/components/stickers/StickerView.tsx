"use client";
// One sticker. Paints the static poster instantly (tiny WebP), then — only while on screen, motion allowed and
// within the device's animation budget — swaps in the Lottie animation (lottie-web light canvas build, loaded
// lazily once). Off-screen animations pause; unmounting destroys them. WebP/PNG stickers are plain <img>s
// (animated WebP is decoded natively by the browser).
import { memo, useEffect, useRef, useState } from "react";
import type { Sticker } from "@/lib/stickers/types";
import { fileUrl } from "@/lib/stickers/client";
import { cn } from "@/lib/utils";

type LottieAnim = { play(): void; pause(): void; destroy(): void; addEventListener(ev: string, fn: () => void): void; setSubframe?(v: boolean): void };
type LottiePlayer = { loadAnimation(o: Record<string, unknown>): LottieAnim };

let lottieP: Promise<LottiePlayer> | null = null;
const loadLottie = () =>
  (lottieP ??= import("lottie-web/build/player/lottie_light_canvas").then((m) => (m.default ?? m) as unknown as LottiePlayer).catch((e) => {
    lottieP = null;
    throw e;
  }));
const dataCache = new Map<string, Promise<string>>();
/** Lottie JSON text is cached once; each instance parses its own copy (lottie annotates the data while parsing). */
const loadData = (url: string) => {
  let p = dataCache.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    });
    p.catch(() => dataCache.delete(url));
    dataCache.set(url, p);
  }
  return p.then((t) => JSON.parse(t) as unknown);
};

/** Low-end devices / reduced motion: fewer simultaneous animations (or none). */
function budget(): number {
  if (typeof window === "undefined") return 0;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return 0;
  const n = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
  if (n.connection?.saveData) return 4;
  const low = (n.hardwareConcurrency ?? 8) <= 4 || (n.deviceMemory ?? 8) <= 2;
  return low ? 8 : 24;
}
let playing = 0;

let io: IntersectionObserver | null = null;
const ioSubs = new Map<Element, (v: boolean) => void>();
function observe(el: Element, fn: (visible: boolean) => void) {
  if (typeof IntersectionObserver === "undefined") {
    fn(true);
    return () => {};
  }
  io ??= new IntersectionObserver((entries) => entries.forEach((e) => ioSubs.get(e.target)?.(e.isIntersecting)), { rootMargin: "120px" });
  ioSubs.set(el, fn);
  io.observe(el);
  return () => {
    ioSubs.delete(el);
    io?.unobserve(el);
  };
}

export const StickerView = memo(function StickerView({
  sticker,
  size,
  animate = true,
  loop = true,
  className,
  title,
}: {
  sticker: Sticker;
  size: number;
  /** false = poster only (e.g. long lists on low-end devices) */
  animate?: boolean;
  loop?: boolean;
  className?: string;
  title?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [live, setLive] = useState(false);
  const [posterOk, setPosterOk] = useState(true);
  const anim = useRef<LottieAnim | null>(null);
  const counted = useRef(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    return observe(el, setVisible);
  }, []);

  const isLottie = sticker.format === "lottie";
  useEffect(() => {
    if (!isLottie || !animate) return;
    if (!visible) {
      anim.current?.pause();
      if (counted.current) {
        counted.current = false;
        playing--;
      }
      return;
    }
    if (playing >= budget()) return;
    playing++;
    counted.current = true;
    if (anim.current) {
      anim.current.play();
      return;
    }
    let cancelled = false;
    Promise.all([loadLottie(), loadData(fileUrl(sticker.file))])
      .then(([lottie, data]) => {
        if (cancelled || !holder.current) return;
        const a = lottie.loadAnimation({
          container: holder.current,
          renderer: "canvas",
          loop,
          autoplay: true,
          animationData: data,
          rendererSettings: { clearCanvas: true, preserveAspectRatio: "xMidYMid meet", dpr: Math.min(2, window.devicePixelRatio || 1) },
        });
        a.addEventListener("DOMLoaded", () => !cancelled && setLive(true));
        anim.current = a;
      })
      .catch(() => {
        /* poster stays */
      });
    return () => {
      cancelled = true;
    };
  }, [visible, animate, isLottie, loop, sticker.file]);

  useEffect(
    () => () => {
      anim.current?.destroy();
      anim.current = null;
      if (counted.current) playing--;
      counted.current = false;
    },
    [],
  );

  // animated WebP (Fluent) plays natively; when animation is off it shows the static poster instead
  const src = isLottie || (!animate && sticker.poster) ? sticker.poster : sticker.file;
  return (
    <div
      ref={box}
      className={cn("relative shrink-0 select-none [contain:strict]", className)}
      style={{ width: size, height: size }}
      title={title}
      role="img"
      aria-label={title ?? `${sticker.emoji} sticker`}
    >
      {src && posterOk ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={fileUrl(src)}
          alt=""
          width={size}
          height={size}
          decoding="async"
          loading="lazy"
          draggable={false}
          onError={() => setPosterOk(false)}
          className={cn("pointer-events-none absolute inset-0 h-full w-full object-contain transition-opacity duration-150", live && "opacity-0")}
        />
      ) : (
        !live && <span className="absolute inset-0 grid place-items-center" style={{ fontSize: size * 0.6, lineHeight: 1 }}>{sticker.emoji}</span>
      )}
      {isLottie && <div ref={holder} className={cn("pointer-events-none absolute inset-0 [&>canvas]:!h-full [&>canvas]:!w-full", !live && "opacity-0")} />}
    </div>
  );
});
