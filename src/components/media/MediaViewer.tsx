"use client";
import { attachAdaptive } from "@/lib/media/adaptive";
// Full-screen photo / video viewer (Telegram style): opens out of the tapped tile, swipe down (or Esc / back) to
// dismiss, pinch / double-tap / wheel zoom with pan for photos, scrubber for videos, swipe or arrows between the
// conversation's photos and videos. Transforms are written straight to the DOM in rAF (no React render per frame).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, Loader2, Pause, Play, Share2, Trash2, Volume2, VolumeX, X } from "lucide-react";
import type { DirectMessage, PublicUser } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatFull, serverNow } from "@/lib/time";
import { formatBytes, formatDuration, formatRemaining, itemsOf, mediaGone, type MediaAttachment } from "@/lib/media/types";
import { deleteMediaNow, getUrls, markViewed } from "@/lib/media/client";
import { mediaNative, prefersReducedMotion, saveData } from "@/lib/media/capabilities";
import { closeViewer, type ViewerTarget } from "./viewerStore";
import { useTick } from "./hooks";

type Urls = { full?: string; thumb?: string; poster?: string; original?: string; hls?: string; hlsLow?: string };

/** one page of the viewer: an attachment and the message carrying it (albums contribute one page per item) */
interface Page {
  m: DirectMessage;
  a: MediaAttachment;
  pos: number;
  count: number;
}
const viewable = (a: MediaAttachment, now: number) =>
  (a.kind === "photo" || a.kind === "video" || (a.kind === "document" && !!a.thumb && a.mime.startsWith("image/"))) && !a.viewOnce && !mediaGone(a, now) && !a.id.startsWith("local-");

export function MediaViewer({ target, messages, me, peer }: { target: ViewerTarget; messages: DirectMessage[]; me: { id: string } | null; peer: PublicUser | null }) {
  const viewOnce = !!target.message.media?.viewOnce;
  // gallery: every viewable photo/video in the thread, album items in order (view once opens alone)
  const gallery = useMemo<Page[]>(() => {
    const t = target.message;
    const single = (m: DirectMessage): Page[] => itemsOf(m).map((a, pos, all) => ({ m, a, pos, count: all.length }));
    if (viewOnce) return single(t).slice(0, 1);
    const now = serverNow();
    const list: Page[] = [];
    for (const m of messages) {
      if (m.id.startsWith("local-")) continue;
      const items = itemsOf(m);
      items.forEach((a, pos) => viewable(a, now) && list.push({ m, a, pos, count: items.length }));
    }
    return list.some((p) => p.m.id === t.id) ? list : single(t);
  }, [messages, target.message, viewOnce]);
  const [index, setIndex] = useState(() => {
    const t = target.message;
    const want = itemsOf(t)[target.index ?? 0]?.id;
    const i = gallery.findIndex((p) => p.m.id === t.id && (!want || p.a.id === want));
    return Math.max(0, i >= 0 ? i : gallery.findIndex((p) => p.m.id === t.id));
  });
  const page = gallery[Math.min(index, gallery.length - 1)];
  const cur = page?.m;
  const a = page?.a;
  const [urls, setUrls] = useState<Urls | null>(viewOnce ? target.viewOnceUrls ?? null : null);
  const [chrome, setChrome] = useState(true);
  const [confirmDel, setConfirmDel] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const reduced = prefersReducedMotion();
  useTick(!!a?.expiresAt, 1000);

  // the message disappeared under us (expired / deleted for everyone) → close
  const live = messages.find((m) => m.id === cur?.id);
  const liveItem = live && a ? itemsOf(live).find((x) => x.id === a.id) : undefined;
  const goneNow = !viewOnce && !!live?.media && (!liveItem || mediaGone(liveItem, serverNow()));

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const el = stage.current;
    if (el && !reduced) {
      el.style.transition = "transform 180ms ease-in, opacity 180ms ease-in";
      el.style.opacity = "0";
      el.style.transform += " scale(0.92)";
    }
    if (backdrop.current) {
      backdrop.current.style.transition = "opacity 180ms ease-in";
      backdrop.current.style.opacity = "0";
    }
    setTimeout(closeViewer, reduced ? 0 : 170);
  }, [reduced]);

  useEffect(() => {
    if (goneNow) close();
  }, [goneNow, close]);

  // view once: deleted for both as soon as it's closed; Android blocks screenshots while it's open (next phone build)
  useEffect(() => {
    if (!viewOnce && !target.message.media?.expiresAt) return;
    mediaNative()?.setSecureScreen?.(true);
    const id = target.message.media!.id;
    return () => {
      mediaNative()?.setSecureScreen?.(false);
      if (viewOnce) void markViewed(id);
    };
  }, [viewOnce, target.message.media]);

  // back button / Esc / arrows
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") setIndex((i) => Math.min(gallery.length - 1, i + 1));
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    let pushed = false;
    try {
      window.history.pushState({ ...(window.history.state ?? {}), olViewer: 1 }, "");
      pushed = true;
    } catch {}
    const onPop = () => {
      pushed = false;
      close();
    };
    window.addEventListener("popstate", onPop);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
      document.body.style.overflow = prevOverflow;
      if (pushed && window.history.state?.olViewer) window.history.back();
    };
  }, [close, gallery.length]);

  useEffect(() => {
    if (viewOnce || !a) return;
    let alive = true;
    setUrls(null);
    void getUrls(a).then((u) => alive && setUrls(u));
    return () => {
      alive = false;
    };
  }, [a, viewOnce]);

  // open animation: grow out of the tile
  useLayoutEffect(() => {
    const el = stage.current;
    const from = target.from;
    if (!el || reduced) return;
    if (from && from.width) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const s = Math.max(0.2, Math.min(1, from.width / vw));
      el.style.transform = `translate(${from.left + from.width / 2 - vw / 2}px, ${from.top + from.height / 2 - vh / 2}px) scale(${s})`;
      el.style.opacity = "0.6";
      requestAnimationFrame(() => {
        el.style.transition = "transform 240ms cubic-bezier(.2,.8,.2,1), opacity 160ms ease-out";
        el.style.transform = "";
        el.style.opacity = "1";
      });
    } else {
      el.style.opacity = "0";
      requestAnimationFrame(() => {
        el.style.transition = "opacity 160ms ease-out";
        el.style.opacity = "1";
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!cur || !a) return null;
  const mine = cur.fromId === me?.id;
  const sender = mine ? "You" : peer?.name ?? cur.fromName;
  const canSave = !a.expiresAt && !a.viewOnce;
  const isVideo = a.kind === "video";

  const canShare = canSave && typeof navigator !== "undefined" && typeof navigator.share === "function" && typeof navigator.canShare === "function";
  const share = async () => {
    try {
      const u = await getUrls(a, true);
      const href = u.full ?? u.original;
      if (!href) return;
      const blob = await (await fetch(href)).blob();
      const file = new File([blob], a.name || (isVideo ? "video.mp4" : "photo.jpg"), { type: blob.type || a.mime });
      if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
      else await download();
    } catch {
      /* share sheet dismissed */
    }
  };
  const album = page.count > 1;
  // (in-app confirm: window.confirm is a silent "false" in some WebViews)
  const removeItem = async () => {
    setConfirmDel(false);
    await deleteMediaNow(a.id).catch(() => {});
  };

  const download = async () => {
    const u = await getUrls(a, true);
    const href = u.full ?? u.original;
    if (!href) return;
    const n = mediaNative();
    const dl = href + "&dl=1";
    if (n?.openFile) return n.openFile(new URL(dl, location.href).href, a.name || "photo.jpg", a.mime);
    const link = document.createElement("a");
    link.href = dl;
    link.download = a.name || (isVideo ? "video.mp4" : "photo.jpg");
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  return createPortal(
    <div ref={root} className="fixed inset-0 z-[100] touch-none overscroll-none select-none" role="dialog" aria-modal="true" aria-label={isVideo ? "Video" : "Photo"} data-testid="media-viewer">
      <div ref={backdrop} className="absolute inset-0 bg-black" />
      <div ref={stage} className="absolute inset-0 will-change-transform">
        {isVideo ? (
          <VideoStage key={a.id} a={a} urls={urls} onToggleChrome={() => setChrome((c) => !c)} onDismiss={close} backdrop={backdrop} stage={stage} />
        ) : (
          <PhotoStage
            key={a.id}
            a={a}
            urls={urls}
            onToggleChrome={() => setChrome((c) => !c)}
            onDismiss={close}
            onSwipe={(dir) => setIndex((i) => Math.min(gallery.length - 1, Math.max(0, i + dir)))}
            backdrop={backdrop}
            stage={stage}
          />
        )}
      </div>
      {/* top bar */}
      <div
        className={cn(
          "absolute inset-x-0 top-0 flex items-center gap-2 bg-gradient-to-b from-black/70 to-transparent px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-6 text-white transition-opacity duration-200",
          chrome ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <button onClick={close} className="rounded-full p-2 hover:bg-white/10" aria-label="Close" data-testid="viewer-close">
          <X className="h-6 w-6" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{sender}</div>
          <div className="truncate text-xs text-white/70">
            {album ? `${page.pos + 1} of ${page.count} · ` : gallery.length > 1 ? `${index + 1} of ${gallery.length} · ` : ""}
            {a.viewOnce ? "View once" : a.expiresAt ? `Expires in ${formatRemaining(a.expiresAt - serverNow())}` : formatFull(cur.createdAt)}
          </div>
        </div>
        {mine && (a.expiresAt || a.viewOnce) && (
          <button
            onClick={async () => {
              // self-destructing album: the timer covers every item, so does Delete now
              await deleteMediaNow(a.id, { all: album }).catch(() => {});
              close();
            }}
            className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-semibold text-red-300 hover:bg-white/10"
          >
            <Trash2 className="h-4 w-4" /> Delete now
          </button>
        )}
        {canShare && (
          <button onClick={share} className="rounded-full p-2 hover:bg-white/10" aria-label="Share" data-testid="viewer-share">
            <Share2 className="h-5 w-5" />
          </button>
        )}
        {canSave && (
          <button onClick={download} className="rounded-full p-2 hover:bg-white/10" aria-label="Save" data-testid="viewer-save">
            <Download className="h-5 w-5" />
          </button>
        )}
        {mine && album && canSave && (
          <button onClick={() => setConfirmDel(true)} className="rounded-full p-2 text-red-300 hover:bg-white/10" aria-label="Delete from album" data-testid="viewer-delete-item">
            <Trash2 className="h-5 w-5" />
          </button>
        )}
      </div>
      {gallery.length > 1 && chrome && (
        <>
          {index > 0 && (
            <button onClick={() => setIndex(index - 1)} className="absolute top-1/2 left-2 hidden -translate-y-1/2 rounded-full bg-black/40 p-2 text-white hover:bg-black/60 sm:block" aria-label="Previous">
              <ChevronLeft className="h-6 w-6" />
            </button>
          )}
          {index < gallery.length - 1 && (
            <button onClick={() => setIndex(index + 1)} className="absolute top-1/2 right-2 hidden -translate-y-1/2 rounded-full bg-black/40 p-2 text-white hover:bg-black/60 sm:block" aria-label="Next">
              <ChevronRight className="h-6 w-6" />
            </button>
          )}
        </>
      )}
      {confirmDel && (
        <div className="absolute inset-x-0 bottom-0 z-10 flex flex-wrap items-center justify-center gap-2 bg-zinc-900/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-white" role="alertdialog" aria-label="Delete this item from the album for everyone?">
          <span className="w-full text-center text-sm sm:w-auto">Delete this item from the album for everyone?</span>
          <button onClick={() => setConfirmDel(false)} className="rounded-full px-4 py-2 text-sm font-semibold hover:bg-white/10">
            Cancel
          </button>
          <button onClick={removeItem} className="rounded-full bg-red-500 px-4 py-2 text-sm font-semibold hover:bg-red-400" data-testid="viewer-delete-confirm">
            Delete
          </button>
        </div>
      )}
      {!a.label && cur.text && chrome && !confirmDel && (
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-4 pt-8 pb-[max(1rem,env(safe-area-inset-bottom))] text-center text-[15px] whitespace-pre-wrap text-white">{cur.text}</div>
      )}
    </div>,
    document.body,
  );
}

/** swipe-down-to-dismiss shared by both stages: returns true when it consumed the gesture */
function dismissDrag(dy: number, stage: React.RefObject<HTMLDivElement | null>, backdrop: React.RefObject<HTMLDivElement | null>) {
  const s = stage.current;
  const b = backdrop.current;
  if (s) {
    s.style.transition = "none";
    s.style.transform = `translateY(${dy}px) scale(${1 - Math.min(0.15, Math.abs(dy) / 2000)})`;
  }
  if (b) {
    b.style.transition = "none";
    b.style.opacity = String(Math.max(0.2, 1 - Math.abs(dy) / 500));
  }
}
function resetDrag(stage: React.RefObject<HTMLDivElement | null>, backdrop: React.RefObject<HTMLDivElement | null>) {
  const s = stage.current;
  const b = backdrop.current;
  if (s) {
    s.style.transition = "transform 200ms cubic-bezier(.2,.8,.2,1)";
    s.style.transform = "";
  }
  if (b) {
    b.style.transition = "opacity 200ms";
    b.style.opacity = "1";
  }
}

function PhotoStage({
  a,
  urls,
  onToggleChrome,
  onDismiss,
  onSwipe,
  backdrop,
  stage,
}: {
  a: MediaAttachment;
  urls: Urls | null;
  onToggleChrome: () => void;
  onDismiss: () => void;
  onSwipe: (dir: 1 | -1) => void;
  backdrop: React.RefObject<HTMLDivElement | null>;
  stage: React.RefObject<HTMLDivElement | null>;
}) {
  const [saver] = useState(() => saveData());
  const [hd, setHd] = useState(false);
  const img = useRef<HTMLDivElement>(null);
  const [fullLoaded, setFullLoaded] = useState(false);
  const t = useRef({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ kind: "none" | "pan" | "pinch" | "dismiss" | "swipe"; startX: number; startY: number; startT: { scale: number; x: number; y: number }; dist: number; cx: number; cy: number; t0: number }>({
    kind: "none",
    startX: 0,
    startY: 0,
    startT: { scale: 1, x: 0, y: 0 },
    dist: 0,
    cx: 0,
    cy: 0,
    t0: 0,
  });
  const lastTap = useRef(0);
  const raf = useRef(0);

  const apply = (animate = false) => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const el = img.current;
      if (!el) return;
      el.style.transition = animate ? "transform 220ms cubic-bezier(.2,.8,.2,1)" : "none";
      el.style.transform = `translate3d(${t.current.x}px, ${t.current.y}px, 0) scale(${t.current.scale})`;
    });
  };
  const clamp = () => {
    const s = t.current.scale;
    if (s <= 1) {
      t.current = { scale: 1, x: 0, y: 0 };
      return;
    }
    const el = img.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const mx = (w * (s - 1)) / 2;
    const my = (h * (s - 1)) / 2;
    t.current.x = Math.max(-mx, Math.min(mx, t.current.x));
    t.current.y = Math.max(-my, Math.min(my, t.current.y));
  };
  const zoomAt = (s: number, cx: number, cy: number) => {
    const el = img.current;
    if (!el) return;
    const r = el.parentElement!.getBoundingClientRect();
    const px = cx - (r.left + r.width / 2);
    const py = cy - (r.top + r.height / 2);
    const k = s / t.current.scale;
    t.current = { scale: s, x: px - (px - t.current.x) * k, y: py - (py - t.current.y) * k };
    clamp();
  };

  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (pointers.current.size === 2) {
      const [p1, p2] = [...pointers.current.values()];
      g.kind = "pinch";
      g.dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      g.cx = (p1.x + p2.x) / 2;
      g.cy = (p1.y + p2.y) / 2;
      g.startT = { ...t.current };
    } else {
      g.kind = "none";
      g.startX = e.clientX;
      g.startY = e.clientY;
      g.startT = { ...t.current };
      g.t0 = performance.now();
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (g.kind === "pinch" && pointers.current.size >= 2) {
      const [p1, p2] = [...pointers.current.values()];
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const s = Math.max(1, Math.min(5, (g.startT.scale * d) / Math.max(1, g.dist)));
      t.current = { ...g.startT };
      zoomAt(s, g.cx, g.cy);
      apply();
      return;
    }
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (g.kind === "none" && Math.hypot(dx, dy) > 8) {
      if (t.current.scale > 1) g.kind = "pan";
      else if (Math.abs(dy) > Math.abs(dx)) g.kind = "dismiss";
      else g.kind = "swipe";
    }
    if (g.kind === "pan") {
      t.current = { scale: g.startT.scale, x: g.startT.x + dx, y: g.startT.y + dy };
      clamp();
      apply();
    } else if (g.kind === "dismiss") dismissDrag(dy, stage, backdrop);
    else if (g.kind === "swipe" && img.current) {
      img.current.style.transition = "none";
      img.current.style.transform = `translate3d(${dx}px,0,0)`;
    }
  };
  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    const dt = performance.now() - g.t0;
    if (g.kind === "pinch") {
      if (pointers.current.size === 0) {
        clamp();
        apply(true);
        g.kind = "none";
      }
      return;
    }
    if (g.kind === "dismiss") {
      if (Math.abs(dy) > 110 || Math.abs(dy) / dt > 0.6) onDismiss();
      else resetDrag(stage, backdrop);
    } else if (g.kind === "swipe") {
      if (Math.abs(dx) > 80 || Math.abs(dx) / dt > 0.5) onSwipe(dx < 0 ? 1 : -1);
      t.current = { scale: 1, x: 0, y: 0 };
      apply(true);
    } else if (g.kind === "none") {
      // tap: double-tap zooms, single tap toggles the chrome
      const now = performance.now();
      if (now - lastTap.current < 280) {
        lastTap.current = 0;
        if (t.current.scale > 1) t.current = { scale: 1, x: 0, y: 0 };
        else zoomAt(2.5, e.clientX, e.clientY);
        apply(true);
      } else {
        lastTap.current = now;
        setTimeout(() => lastTap.current && performance.now() - lastTap.current >= 270 && onToggleChrome(), 290);
      }
    }
    g.kind = "none";
  };
  const onWheel = (e: React.WheelEvent) => {
    const s = Math.max(1, Math.min(5, t.current.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    zoomAt(s, e.clientX, e.clientY);
    apply();
  };

  const ar = a.w && a.h ? a.w / a.h : 4 / 3;
  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-hidden" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel}>
      <div ref={img} className="relative will-change-transform" style={{ aspectRatio: String(ar), width: `min(100vw, calc(100dvh * ${ar}))`, maxHeight: "100dvh" }}>
        {a.ph && <img src={a.ph} alt="" className="absolute inset-0 h-full w-full object-contain blur-lg" draggable={false} />}
        {urls?.thumb && <img src={urls.thumb} alt="" className="absolute inset-0 h-full w-full object-contain" draggable={false} />}
        {urls?.full && (!saver || hd) && <img src={urls.full} alt={a.name ?? "Photo"} decoding="async" onLoad={() => setFullLoaded(true)} className={cn("absolute inset-0 h-full w-full object-contain transition-opacity duration-150", fullLoaded ? "opacity-100" : "opacity-0")} draggable={false} />}
        {!fullLoaded && (!saver || hd) && <Loader2 className="absolute inset-0 m-auto h-7 w-7 animate-spin text-white/70 motion-reduce:animate-none" />}
      </div>
      {/* data saver: the 640px preview is shown; full quality only on request */}
      {saver && !hd && urls?.full && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={() => setHd(true)}
          className="absolute bottom-[max(5rem,calc(env(safe-area-inset-bottom)+4rem))] left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-4 py-2 text-sm font-medium text-white backdrop-blur"
          data-testid="viewer-load-hd"
        >
          Load full quality · {formatBytes(a.size)}
        </button>
      )}
    </div>
  );
}

function VideoStage({
  a,
  urls,
  onToggleChrome,
  onDismiss,
  backdrop,
  stage,
}: {
  a: MediaAttachment;
  urls: Urls | null;
  onToggleChrome: () => void;
  onDismiss: () => void;
  backdrop: React.RefObject<HTMLDivElement | null>;
  stage: React.RefObject<HTMLDivElement | null>;
}) {
  const v = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(!!a.gif);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState((a.durMs ?? 0) / 1000);
  const [waiting, setWaiting] = useState(true);
  const [failed, setFailed] = useState(false);
  const drag = useRef<{ y: number; x: number; t0: number; active: boolean } | null>(null);
  const mp4 = urls?.full ?? urls?.original;
  // adaptive: HLS ladder when it exists (hls.js / native), else the faststart MP4. GIF loops stay on the MP4.
  const hls = !a.gif && a.hls?.length ? urls?.hls : undefined;
  const src = hls ?? mp4;
  const srcKey = `${hls ? hls.split("?")[0] : ""}|${mp4 ? mp4.split("?")[0] : ""}`;

  useEffect(() => {
    const el = v.current;
    if (!el || !src) return;
    const detach = attachAdaptive(el, { hls, hlsLow: hls ? urls?.hlsLow : undefined, mp4 }, { id: a.id, onFatal: () => setFailed(true) });
    el.muted = !!a.gif;
    const p = el.play();
    // autoplay with sound can be refused (no gesture reached the element on some engines): retry muted
    if (p)
      p.catch(() => {
        el.muted = true;
        setMuted(true);
        void el.play().catch(() => setPlaying(false));
      });
    return detach;
    // re-attach only when the media itself changes (signed-URL refreshes keep the running player)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey, a.gif]);

  return (
    <div
      className="absolute inset-0 flex items-center justify-center"
      onPointerDown={(e) => (drag.current = { y: e.clientY, x: e.clientX, t0: performance.now(), active: false })}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dy = e.clientY - d.y;
        if (!d.active && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(e.clientX - d.x)) d.active = true;
        if (d.active) dismissDrag(dy, stage, backdrop);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        const dy = e.clientY - d.y;
        if (d.active) {
          if (Math.abs(dy) > 110 || Math.abs(dy) / (performance.now() - d.t0) > 0.6) onDismiss();
          else resetDrag(stage, backdrop);
        } else onToggleChrome();
      }}
    >
      {!src && a.ph && <img src={a.ph} alt="" className="absolute inset-0 m-auto max-h-full max-w-full object-contain blur-lg" />}
      {src && !failed && (
        <video
          ref={v}
          poster={urls?.poster}
          playsInline
          loop={!!a.gif}
          preload="metadata"
          className="max-h-full max-w-full"
          style={{ aspectRatio: a.w && a.h ? `${a.w}/${a.h}` : undefined }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onCanPlay={() => setWaiting(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
          onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
          onError={() => setFailed(true)}
          // eslint-disable-next-line react/no-unknown-property
          {...{ "webkit-playsinline": "true" }}
        />
      )}
      {failed && <div className="px-6 text-center text-sm text-white/80">This video can&apos;t play here. {a.status === "processing" ? "It's still being prepared. Try again in a moment." : "Save it to watch."}</div>}
      {waiting && src && !failed && <Loader2 className="pointer-events-none absolute h-8 w-8 animate-spin text-white/80 motion-reduce:animate-none" />}
      {!a.gif && (
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-gradient-to-t from-black/75 to-transparent px-4 pt-10 pb-[max(1rem,env(safe-area-inset-bottom))] text-white" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
          <button onClick={() => (playing ? v.current?.pause() : void v.current?.play())} aria-label={playing ? "Pause" : "Play"} className="rounded-full p-1.5 hover:bg-white/10">
            {playing ? <Pause className="h-6 w-6 fill-current" /> : <Play className="h-6 w-6 fill-current" />}
          </button>
          <span className="w-11 text-right text-xs tabular-nums">{formatDuration(time * 1000)}</span>
          <input
            type="range"
            min={0}
            max={dur || 0}
            step={0.05}
            value={Math.min(time, dur || 0)}
            onChange={(e) => {
              const el = v.current;
              if (el) el.currentTime = Number(e.target.value);
              setTime(Number(e.target.value));
            }}
            aria-label="Seek"
            className="h-1 min-w-0 flex-1 cursor-pointer accent-emerald-400"
          />
          <span className="w-11 text-xs tabular-nums">{formatDuration(dur * 1000)}</span>
          <button
            onClick={() => {
              const el = v.current;
              if (el) el.muted = !el.muted;
            }}
            aria-label={muted ? "Unmute" : "Mute"}
            className="rounded-full p-1.5 hover:bg-white/10"
          >
            {muted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
          </button>
        </div>
      )}
    </div>
  );
}
