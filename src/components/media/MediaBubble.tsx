"use client";
// Chat bubbles for attachments: photo / video / GIF tiles (blurred placeholder → thumbnail, fixed aspect ratio so
// nothing shifts), documents (type icon, name, size, progress ring), voice notes (waveform scrubber, speed, played dot),
// self-destruct badges and the grey "Photo expired" placeholder. Rendered inside the chat worker's MessageRow.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Flame,
  Loader2,
  Pause,
  Play,
  Presentation,
  RotateCw,
  Smartphone,
  Timer,
  Trash2,
  VolumeX,
  X,
} from "lucide-react";
import type { DirectMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { VideoFirstFrame, VideoSkeleton } from "./VideoFirstFrame";
import { serverNow } from "@/lib/time";
import {
  docFamily,
  formatBadge,
  formatBytes,
  formatDuration,
  formatRemaining,
  goneLabel,
  itemsOf,
  mediaGone,
  type MediaAttachment,
} from "@/lib/media/types";
import { cancelMedia, useOutbox } from "@/lib/media/outbox";
import { getUrls, markPlayed, openViewOnce } from "@/lib/media/client";
import { cycleRate, pauseVoice, playVoice, registerVoice, seekVoice, useVoiceState } from "@/lib/media/player";
import { inNativeApp, mediaNative, prefersReducedMotion, saveData } from "@/lib/media/capabilities";
import { PLAYBACK_EVENT, exclusivePlaying, measuredBps, prefetchPlayer } from "@/lib/media/adaptive";
import { linkBps, linkSlow, networkHint } from "@/lib/dataSaver";
import { afterCritical, beginCritical } from "@/lib/media/critical";
import { useInView, useMediaUrls, useTick } from "./hooks";
import { CountdownRing, ProgressRing } from "./Rings";
import { openViewer } from "./viewerStore";
import { LinkifiedText } from "../chat/LinkifiedText";

type Msg = DirectMessage & { state?: "sending" | "failed" };

/** Does this message render as an attachment bubble? */
export const isMediaMessage = (m: DirectMessage) => !!m.media;

/** Message-action rules for attachments (used by the long-press menu): copy only when there's a caption, etc. */
export function mediaActions(m: DirectMessage, myId: string | undefined) {
  const a = m.media;
  if (!a) return null;
  const gone = mediaGone(a, serverNow());
  const mine = m.fromId === myId;
  const expiring = !!a.expiresAt || !!a.viewOnce;
  const items = itemsOf(m);
  return {
    /** albums: number of items (reply quote: first thumbnail + "Album, 5 photos"); 1 for single attachments */
    count: items.length,
    /** reply-quote text for this attachment message */
    quote: items.length > 1 ? `Album, ${albumCounts(items)}` : gone ? goneLabel(a) : m.text,
    /** the attachment whose thumbnail the reply quote shows (album → first item) */
    quoteMedia: gone ? null : items[0] ?? null,
    /** per-item actions inside the full-screen viewer: save always (unless self-destructing), delete one item (sender) */
    perItem: items.length > 1 ? { save: !expiring, deleteItem: mine && !expiring } : null,
    /** "Delete now" on an album deletes every item: call deleteMediaNow(id, { all: true }) */
    deleteAll: items.length > 1,
    /** Copy: the caption only (never for voice notes or caption-less media) */
    copyText: !a.label && a.kind !== "voice" && !gone ? m.text : null,
    /** sender's "Delete now" for self-destructing media (removes the file for both sides) */
    deleteNow: mine && !gone && !m.id.startsWith("local-") ? a.id : null,
    /** Save / download (not for self-destructing media) */
    save: !gone && !expiring && !m.id.startsWith("local-"),
    /** "Expires in 59m" line for the info row */
    info: expiryInfo(a),
    reply: true,
    react: true,
  };
}

function albumCounts(items: MediaAttachment[]) {
  const p = items.filter((x) => x.kind === "photo").length;
  const v = items.length - p;
  if (!v) return `${p} photos`;
  if (!p) return `${v} videos`;
  return `${items.length} items`;
}

export function expiryInfo(a: MediaAttachment | undefined, now = serverNow()) {
  if (!a || a.gone) return null;
  if (a.viewOnce && !a.openedAt) return "View once";
  if (a.expiresAt) return `Expires in ${formatRemaining(a.expiresAt - now)}`;
  if (a.ttl) return "Self-destructs after sending";
  return null;
}

/** visual tile size: Telegram-like caps, aspect ratio clamped, never wider than the bubble column */
function tileBox(a: MediaAttachment) {
  const ar = a.w && a.h ? a.w / a.h : a.kind === "video" ? 16 / 9 : 4 / 3;
  const clamped = Math.min(1.9, Math.max(0.62, ar));
  const width = Math.round(Math.min(330, 380 * clamped));
  // CSS width: also capped by the viewport height so a tile never fills a landscape phone (no layout shift: the
  // aspect ratio fixes the height from this width)
  return { width, ar: clamped, css: `min(${width}px, calc(62vh * ${clamped.toFixed(3)}))` };
}

export const MediaBubble = memo(function MediaBubble({ m, mine, shape, onRetry }: { m: Msg; mine: boolean; shape: string; onRetry?: (m: Msg) => void }) {
  const a = m.media!;
  const now = serverNow();
  const gone = mediaGone(a, now);
  // tick while a short self-destruct timer runs (re-renders this bubble only)
  const left = a.expiresAt ? a.expiresAt - now : 0;
  useTick(!gone && !!a.expiresAt && left < 3_600_000, left < 60_000 ? 1000 : 15_000);
  useTick(!gone && !!a.expiresAt && left >= 3_600_000, 60_000);
  const caption = !a.label && !gone ? m.text : "";

  if (gone) return <GoneTile a={a} mine={mine} shape={shape} />;
  const album = m.attachments && m.attachments.length > 1 ? m.attachments.filter((x) => !mediaGone(x, now)) : null;
  if (album && album.length > 1)
    return (
      <div className={cn("relative overflow-hidden", shape, mine ? "bg-emerald-500" : "dm-theirs bg-zinc-800")} style={{ width: tileBox(album[0]).css, maxWidth: "100%" }}>
        <AlbumCarousel m={m} items={album} onRetry={onRetry} />
        {caption && <Caption text={caption} mine={mine} className="px-3 pt-1.5 pb-2" />}
      </div>
    );
  if (a.kind === "photo" || a.kind === "video")
    return (
      <div className={cn("relative overflow-hidden", shape, mine ? "bg-emerald-500" : "dm-theirs bg-zinc-800")} style={{ width: tileBox(a).css, maxWidth: "100%" }}>
        <VisualTile m={m} a={a} mine={mine} onRetry={onRetry} />
        {caption && <Caption text={caption} mine={mine} className="px-3 pt-1.5 pb-2" />}
      </div>
    );
  return (
    <div className={cn("min-w-0", shape, mine ? "bg-emerald-500 text-on-accent" : "dm-theirs bg-zinc-800 text-zinc-100")} style={{ width: a.kind === "voice" ? 280 : 300, maxWidth: "100%" }}>
      {a.kind === "voice" ? <VoiceTile m={m} a={a} mine={mine} onRetry={onRetry} /> : <DocumentTile m={m} a={a} mine={mine} onRetry={onRetry} />}
      {caption && <Caption text={caption} mine={mine} className="px-3.5 pb-2" />}
    </div>
  );
});

/**
 * Captions are the message text: same tokenizer as text bubbles (safe links, #hashtags, @mentions), and the same
 * `data-msg-text` hook that in-chat search highlighting / editing / formatting use for text bubbles.
 */
function Caption({ text, mine, className }: { text: string; mine: boolean; className: string }) {
  return (
    <div data-msg-text className={cn("text-[15px] leading-[1.35] whitespace-pre-wrap break-words [overflow-wrap:anywhere]", mine ? "text-on-accent" : "text-zinc-100", className)}>
      <LinkifiedText text={text} tone={mine ? "onAccent" : "default"} />
    </div>
  );
}

// ---------- self-destruct badge ----------
function ExpiryBadge({ a, onDark = true }: { a: MediaAttachment; onDark?: boolean }) {
  const [tip, setTip] = useState(false);
  if (!a.expiresAt && !a.viewOnce) return null;
  const now = serverNow();
  const left = a.expiresAt ? a.expiresAt - now : 0;
  const frac = a.ttl && a.expiresAt ? left / (a.ttl * 1000) : 1;
  const label = a.viewOnce && !a.ttl ? "1" : a.expiresAt ? formatBadge(left) : "";
  const info = expiryInfo(a) ?? "";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setTip(true);
        setTimeout(() => setTip(false), 2500);
      }}
      title={info}
      aria-label={info}
      data-testid="media-expiry"
      className={cn("pointer-events-auto absolute top-2 right-2 z-10 flex h-6 items-center gap-1 rounded-full px-1.5 text-[11px] font-semibold tabular-nums", onDark ? "bg-black/55 text-white backdrop-blur-sm" : "bg-black/10")}
    >
      {a.viewOnce && !a.ttl ? <Eye className="h-3.5 w-3.5" /> : <CountdownRing left={frac} size={14} />}
      {label}
      {tip && info && <span className="absolute top-7 right-0 rounded-lg bg-zinc-900 px-2 py-1 text-[11px] whitespace-nowrap text-zinc-100 shadow-lg ring-1 ring-white/10">{info}</span>}
    </button>
  );
}

// ---------- photo / video / GIF ----------
function VisualTile({ m, a, mine, onRetry }: { m: Msg; a: MediaAttachment; mine: boolean; onRetry?: (m: Msg) => void }) {
  const box = tileBox(a);
  const [ref, near] = useInView<HTMLDivElement>("800px");
  const outbox = useOutbox(m.clientId);
  const urls = useMediaUrls(a, near);
  const [loaded, setLoaded] = useState(false);
  const isVideo = a.kind === "video";
  const local = outbox?.previewUrl;
  const src = local ?? (isVideo ? urls?.poster : urls?.thumb ?? urls?.full);
  const uploading = !!outbox && outbox.phase !== "done" && outbox.phase !== "failed";
  const failed = m.state === "failed" || outbox?.phase === "failed";
  const viewOnceLocked = !!a.viewOnce;
  // a video near the screen: warm the player chunk once the thumbnails are in, so a tap starts streaming right away
  // (not on data saver; a tap / hover still warms it)
  const warm = near && isVideo && !a.gif && !uploading;
  useEffect(() => {
    if (warm && !saveData()) afterCritical(prefetchPlayer, 2);
  }, [warm]);

  const open = async () => {
    if (uploading || failed || m.id.startsWith("local-")) return;
    const from = (ref.current as HTMLElement | null)?.getBoundingClientRect() ?? null;
    if (a.viewOnce) {
      if (mine) return; // the sender can't open a view-once photo
      try {
        const r = await openViewOnce(a.id);
        openViewer({ message: m, viewOnceUrls: r.urls, from, mode: "visual" });
      } catch {}
      return;
    }
    openViewer({ message: m, from, mode: "visual" });
  };

  return (
    <div
      ref={ref}
      role="button"
      tabIndex={0}
      aria-label={a.viewOnce ? "View once photo" : isVideo ? (a.gif ? "GIF" : `Video, ${formatDuration(a.durMs ?? 0)}`) : "Photo"}
      onClick={open}
      onPointerDown={isVideo && !a.gif ? prefetchPlayer : undefined}
      onPointerEnter={isVideo && !a.gif ? prefetchPlayer : undefined}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open())}
      data-testid={`media-${a.kind}`}
      className="relative w-full cursor-pointer overflow-hidden bg-zinc-900 select-none [-webkit-touch-callout:none]"
      style={{ aspectRatio: String(box.ar) }}
    >
      {/* blurred placeholder: the tile has its final size from the first frame (no layout shift) */}
      {a.ph && <img src={a.ph} alt="" aria-hidden decoding="sync" className={cn("absolute inset-0 h-full w-full scale-110 object-cover blur-xl", viewOnceLocked && "blur-2xl")} draggable={false} />}
      {/* no blurred placeholder yet (just picked, or an old message without one): never a blank tile */}
      {isVideo && !a.ph && !loaded && !local && <VideoSkeleton />}
      {!viewOnceLocked && src && (
        <ThumbImage a={a} urls={urls} src={src} local={local} width={box.width} onLoaded={() => setLoaded(true)} className={cn("absolute inset-0 h-full w-full object-cover transition-opacity duration-200 motion-reduce:transition-none", loaded || local ? "opacity-100" : "opacity-0")} />
      )}
      {isVideo && !viewOnceLocked && !uploading && !failed && a.status !== "processing" && <InlineVideo a={a} urls={urls} />}
      {viewOnceLocked && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/25 text-white">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/45 backdrop-blur-sm">
            <Flame className="h-5 w-5" />
          </span>
          <span className="text-[13px] font-semibold drop-shadow">{mine ? (a.openedAt ? "Opened" : "View once") : "Tap to view once"}</span>
        </div>
      )}
      {isVideo && !viewOnceLocked && (
        <span className="pointer-events-none absolute top-2 left-2 flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[11px] font-semibold text-white tabular-nums backdrop-blur-sm">
          {a.gif ? "GIF" : (
            <>
              {formatDuration(a.durMs ?? 0)} <VolumeX className="h-3 w-3" />
            </>
          )}
        </span>
      )}
      <ExpiryBadge a={a} />
      {uploading && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (m.clientId) cancelMedia(m.clientId);
          }}
          aria-label="Cancel upload"
          data-testid="media-cancel"
          className="absolute inset-0 m-auto flex h-12 w-12 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm"
        >
          <ProgressRing value={outbox.phase === "uploading" ? outbox.progress : undefined} size={48} stroke={3}>
            <X className="h-5 w-5" />
          </ProgressRing>
        </button>
      )}
      {failed && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRetry?.(m);
          }}
          aria-label="Retry"
          className="absolute inset-0 m-auto flex h-12 w-12 items-center justify-center rounded-full bg-black/55 text-white"
        >
          <RotateCw className="h-5 w-5" />
        </button>
      )}
      {!uploading && !failed && a.status === "processing" && isVideo && !a.gif && (
        <span className="pointer-events-none absolute inset-0 m-auto flex h-12 w-12 items-center justify-center rounded-full bg-black/45 text-white">
          <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />
        </span>
      )}
      {/* no play badge: <InlineVideo> autoplays muted inline from the first frame */}
      {failed && outbox?.error && <span className="absolute right-2 bottom-2 left-2 truncate rounded-md bg-black/60 px-2 py-1 text-[11px] text-white">{outbox.error}</span>}
    </div>
  );
}


// ---------- albums: one bubble, swipeable carousel ----------
/**
 * 2–10 photos/videos in one bubble. Native horizontal scroll-snap does touch swipes with the platform's inertia
 * (iOS/Android/WebView alike); mouse drags are mapped onto the same scroller; arrows on hover, keyboard ←/→,
 * page dots and a "2/5" counter. The frame's height is locked to the first item's (clamped) aspect ratio so the
 * thread never shifts; other items letterbox over their own blurred placeholder.
 *
 * Swipe-to-reply (chat worker) coordination — see src/lib/media/gestures.ts (carouselOwnsGesture): touches that start
 * inside are kept (stopPropagation) unless they start on the 20px bubble edges or the carousel is on its last page;
 * those reach the reply gesture (`data-hscroll-pass="1"`).
 */
function AlbumCarousel({ m, items, onRetry }: { m: Msg; items: MediaAttachment[]; onRetry?: (m: Msg) => void }) {
  const frame = tileBox(items[0]);
  const outbox = useOutbox(m.clientId);
  const uploading = !!outbox && outbox.phase !== "done" && outbox.phase !== "failed";
  const failed = m.state === "failed" || outbox?.phase === "failed";
  const [ref, near] = useInView<HTMLDivElement>("800px");
  const scroller = useRef<HTMLDivElement | null>(null);
  const [page, setPage] = useState(0);
  const n = items.length;
  const drag = useRef<{ x: number; left: number; t: number; moved: boolean; id: number } | null>(null);
  const suppressClick = useRef(false);
  const raf = useRef(0);

  const go = useCallback(
    (i: number) => {
      const el = scroller.current;
      if (!el) return;
      const t = Math.max(0, Math.min(n - 1, i));
      el.scrollTo({ left: t * el.clientWidth, behavior: prefersReducedMotion() ? "auto" : "smooth" });
      setPage(t);
    },
    [n],
  );
  // an item removed from the album: stay in range
  useEffect(() => {
    if (page > n - 1) go(n - 1);
  }, [n, page, go]);

  const onScroll = () => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const el = scroller.current;
      if (el && el.clientWidth) setPage(Math.max(0, Math.min(n - 1, Math.round(el.scrollLeft / el.clientWidth))));
    });
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const open = (i: number) => {
    if (suppressClick.current) return;
    if (uploading || failed || m.id.startsWith("local-")) return;
    const from = (ref.current as HTMLElement | null)?.getBoundingClientRect() ?? null;
    openViewer({ message: m, from, mode: "visual", index: i });
  };

  // gestures that should reach the bubble's swipe-to-reply instead of paging
  const passThrough = (clientX: number) => {
    const r = scroller.current?.getBoundingClientRect();
    if (!r) return true;
    const edge = clientX - r.left < 20 || r.right - clientX < 20;
    return edge || page === n - 1;
  };
  const markGesture = (e: React.TouchEvent | React.PointerEvent, clientX: number) => {
    const pass = passThrough(clientX);
    if (scroller.current) scroller.current.dataset.hscrollPass = pass ? "1" : "0";
    // touchstart stops here (a React swipe-to-reply on the row never sees a paging swipe); pointerdown keeps bubbling
    // so the row's long-press (message actions / reactions) still works on an album — it cancels itself on movement
    if (!pass && "touches" in e) e.stopPropagation();
  };

  // mouse: drag the scroller like a touch swipe (touch/pen use native scrolling + snap)
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    markGesture(e, e.clientX);
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    const el = scroller.current!;
    drag.current = { x: e.clientX, left: el.scrollLeft, t: performance.now(), moved: false, id: e.pointerId };
    suppressClick.current = false;
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) > 6) {
      d.moved = true;
      scroller.current!.style.scrollSnapType = "none";
      scroller.current!.setPointerCapture?.(e.pointerId);
    }
    if (d.moved) scroller.current!.scrollLeft = d.left - dx;
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.moved) return;
    const el = scroller.current!;
    const dx = e.clientX - d.x;
    const v = dx / Math.max(1, performance.now() - d.t); // px/ms
    const base = d.left / el.clientWidth;
    // a flick pages even when short; a slow drag snaps to the nearest page
    const target = Math.abs(v) > 0.35 ? Math.round(base) + (dx < 0 ? 1 : -1) : Math.round(el.scrollLeft / el.clientWidth);
    el.style.scrollSnapType = "";
    suppressClick.current = true;
    setTimeout(() => (suppressClick.current = false), 0);
    go(target);
  };

  return (
    <div
      ref={ref}
      className="group relative w-full select-none [-webkit-touch-callout:none]"
      style={{ aspectRatio: String(frame.ar) }}
      role="region"
      aria-roledescription="carousel"
      aria-label={`Album, ${n} items`}
      data-testid="media-album"
    >
      <div
        ref={scroller}
        data-hscroll="album"
        tabIndex={0}
        onScroll={onScroll}
        onTouchStart={(e) => markGesture(e, e.touches[0]?.clientX ?? 0)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            e.stopPropagation();
            go(page + (e.key === "ArrowRight" ? 1 : -1));
          } else if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open(page);
          }
        }}
        className="absolute inset-0 flex snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain bg-zinc-900 outline-none [scrollbar-width:none] focus-visible:ring-2 focus-visible:ring-emerald-400 [&::-webkit-scrollbar]:hidden"
        style={{ touchAction: "pan-x pan-y", WebkitOverflowScrolling: "touch" } as React.CSSProperties}
      >
        {items.map((a, i) => (
          <AlbumPage
            key={a.id}
            a={a}
            i={i}
            n={n}
            frameAr={frame.ar}
            near={near && Math.abs(i - page) <= 1}
            active={i === page}
            local={outbox?.items?.[i]?.previewUrl}
            progress={uploading ? outbox?.items?.[i]?.progress : undefined}
            onOpen={() => open(i)}
          />
        ))}
      </div>
      {/* counter + dots */}
      <span className="pointer-events-none absolute top-2 left-2 z-10 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-semibold text-white tabular-nums backdrop-blur-sm" data-testid="album-counter">
        {page + 1}/{n}
      </span>
      <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 flex justify-center gap-1" aria-hidden>
        {items.map((a, i) => (
          <span key={a.id} className={cn("h-1.5 rounded-full bg-white shadow transition-all duration-200 motion-reduce:transition-none", i === page ? "w-3 opacity-100" : "w-1.5 opacity-60")} />
        ))}
      </div>
      {/* desktop arrows (hover-capable pointers only) */}
      {page > 0 && (
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => (e.stopPropagation(), go(page - 1))}
          aria-label="Previous"
          className="absolute top-1/2 left-1.5 z-10 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:hover)]:flex"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
      )}
      {page < n - 1 && (
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => (e.stopPropagation(), go(page + 1))}
          aria-label="Next"
          data-testid="album-next"
          className="absolute top-1/2 right-1.5 z-10 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:hover)]:flex"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      )}
      <ExpiryBadge a={items[0]} />
      {uploading && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (m.clientId) cancelMedia(m.clientId);
          }}
          aria-label="Cancel upload"
          data-testid="media-cancel"
          className="absolute right-2 bottom-6 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm"
        >
          <ProgressRing value={outbox.phase === "uploading" ? outbox.progress : undefined} size={40} stroke={2.5}>
            <X className="h-4 w-4" />
          </ProgressRing>
        </button>
      )}
      {failed && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRetry?.(m);
          }}
          aria-label="Retry"
          className="absolute inset-0 z-10 m-auto flex h-12 w-12 items-center justify-center rounded-full bg-black/55 text-white"
        >
          <RotateCw className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}

const AlbumPage = memo(function AlbumPage({
  a,
  i,
  n,
  frameAr,
  near,
  active,
  local,
  progress,
  onOpen,
}: {
  a: MediaAttachment;
  i: number;
  n: number;
  frameAr: number;
  near: boolean;
  active: boolean;
  local?: string;
  progress?: number;
  onOpen: () => void;
}) {
  const urls = useMediaUrls(a, near);
  const [loaded, setLoaded] = useState(false);
  const isVideo = a.kind === "video";
  const src = local ?? (isVideo ? urls?.poster : urls?.thumb ?? urls?.full);
  const ar = a.w && a.h ? a.w / a.h : frameAr;
  // close to the frame → fill it; very different shape → show it whole over its blurred placeholder
  const fit = Math.abs(ar / frameAr - 1) < 0.28 ? "object-cover" : "object-contain";
  return (
    <div
      role="button"
      tabIndex={-1}
      onClick={onOpen}
      aria-roledescription="slide"
      aria-label={`${isVideo ? `Video, ${formatDuration(a.durMs ?? 0)}` : "Photo"} ${i + 1} of ${n}`}
      data-testid="album-page"
      className="relative h-full w-full shrink-0 cursor-pointer snap-center overflow-hidden [scroll-snap-stop:always]"
    >
      {a.ph && <img src={a.ph} alt="" aria-hidden decoding="sync" className="absolute inset-0 h-full w-full scale-110 object-cover blur-xl" draggable={false} />}
      {src && (
        <ThumbImage a={a} urls={urls} src={src} local={local} width={330} onLoaded={() => setLoaded(true)} className={cn("absolute inset-0 h-full w-full transition-opacity duration-200 motion-reduce:transition-none", fit, loaded || local ? "opacity-100" : "opacity-0")} />
      )}
      {isVideo && active && progress === undefined && <InlineVideo a={a} urls={urls} />}
      {isVideo && (
        <span className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[11px] font-semibold text-white tabular-nums backdrop-blur-sm">
          {a.gif ? "GIF" : (
            <>
              {formatDuration(a.durMs ?? 0)} <VolumeX className="h-3 w-3" />
            </>
          )}
        </span>
      )}
      {progress !== undefined && progress < 1 && (
        <span className="pointer-events-none absolute inset-0 m-auto flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-sm" data-testid="album-item-progress">
          <ProgressRing value={progress} size={40} stroke={2.5} />
        </span>
      )}
    </div>
  );
});

declare global {
  interface Window {
    __olThumbStats?: { id: string; ms: number; ok: boolean }[];
  }
}

/**
 * Photo / poster thumbnail: progressive AVIF → WebP via srcset at 320/640 for the tile's CSS width (data saver: the
 * 320 one), lazy + async decode, the blurred inline placeholder stays underneath (no layout shift). A failed or
 * stalled load (bad network) keeps the placeholder and shows "Tap to retry".
 */
function ThumbImage({ a, urls, src, local, width, className, onLoaded }: { a: MediaAttachment; urls: ReturnType<typeof useMediaUrls>; src: string; local?: string; width: number; className: string; onLoaded: () => void }) {
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const t0 = useRef(0);
  useEffect(() => {
    if (local || state !== "loading") return;
    t0.current = performance.now();
    // on screen thumbnails go before deferred downloads (quick-reaction animations, the player chunk)
    const done = beginCritical();
    // a stalled load shows "Tap to retry"; slow links get longer before we call it stalled
    const t = setTimeout(() => setState((s) => (s === "loading" ? "error" : s)), linkSlow() ? 45_000 : 20_000);
    return () => {
      clearTimeout(t);
      done();
    };
  }, [local, state, attempt]);
  const record = (ok: boolean) => {
    if (local) return;
    const list = (window.__olThumbStats ??= []);
    list.push({ id: a.id, ms: Math.round(performance.now() - t0.current), ok });
    if (list.length > 200) list.shift();
  };
  const bust = (u: string) => (attempt && !local ? `${u}${u.includes("?") ? "&" : "?"}r=${attempt}` : u);
  // data saver or a slow link → the 320px candidates; otherwise the tile's CSS width (DPR picks 640 on phones)
  const sizes = saveData() || networkHint().slow || (measuredBps() ?? Infinity) < 600_000 || (linkBps() ?? Infinity) < 800_000 ? "160px" : `${width}px`;
  const img = (
    <img
      src={bust(src)}
      alt=""
      decoding="async"
      // the tile only mounts this once it's within ~800px of the screen (IntersectionObserver), so no native lazy
      // loading on top (it defers past layout and drops the request's priority); fetch it ahead of scripts/emoji
      loading="eager"
      fetchPriority="high"
      draggable={false}
      onLoad={(e) => {
        // cross-fade only once the bitmap is decoded (no half-painted / janky swap)
        const im = e.currentTarget;
        void (im.decode ? im.decode() : Promise.resolve())
          .catch(() => {})
          .then(() => {
            setState("loaded");
            record(true);
            onLoaded();
          });
      }}
      onError={() => {
        setState("error");
        record(false);
      }}
      className={cn(className, state === "error" && "invisible")}
    />
  );
  // a just-sent video's local preview is the video file itself: an <img> can't decode it (it used to flash
  // "Tap to retry" until the server poster replaced it), so show its first frame with a muted, paused <video>
  if (local && src === local && a.kind === "video")
    return <LocalPreviewVideo local={local} className={className} onLoaded={onLoaded} />;
  const responsive = !local && a.kind === "photo" && a.srcset && urls?.thumbS && urls.thumb;
  return (
    <>
      {responsive ? (
        <picture>
          {urls.thumbSAvif && urls.thumbAvif && <source type="image/avif" srcSet={`${bust(urls.thumbSAvif)} 320w, ${bust(urls.thumbAvif)} 640w`} sizes={sizes} />}
          <source type="image/webp" srcSet={`${bust(urls.thumbS!)} 320w, ${bust(urls.thumb!)} 640w`} sizes={sizes} />
          {img}
        </picture>
      ) : (
        img
      )}
      {state === "error" && (
        <button
          type="button"
          data-testid="media-retry"
          onClick={(e) => {
            e.stopPropagation();
            setState("loading");
            setAttempt((n) => n + 1);
          }}
          className="absolute inset-0 m-auto flex h-9 w-fit items-center gap-1.5 rounded-full bg-black/55 px-3 text-[13px] font-medium text-white backdrop-blur-sm"
        >
          <RotateCw className="h-4 w-4" /> Tap to retry
        </button>
      )}
    </>
  );
}

/**
 * A small shared-media image that stays hidden until `img.decode()` resolves. It is deliberately used for
 * image documents and original-format GIFs too: both used to bypass the Telegram thumbnail/blur contract.
 * Callers keep their poster, blurred preview, or file icon mounted underneath; this component never adds a
 * loading wheel and never causes a layout shift.
 */
function DecodeGatedImage({ src, placeholder, alt = "", className, testId }: { src: string; placeholder?: string; alt?: string; className: string; testId?: string }) {
  const [decodedSrc, setDecodedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const decoded = decodedSrc === src;
  return (
    <>
      {placeholder && <img src={placeholder} alt="" aria-hidden decoding="sync" className="absolute inset-0 h-full w-full scale-110 object-cover blur-xl" draggable={false} />}
      <img
        key={src}
        src={src}
        alt={alt}
        decoding="async"
        draggable={false}
        data-testid={testId}
        onLoad={(e) => {
          const image = e.currentTarget;
          // `load` only proves bytes arrived. Hold the sharp bitmap until the decoder has finished so a slow
          // WebKit/Android image never flashes over its thumbnail or file icon half-painted.
          void (image.decode ? image.decode() : Promise.resolve())
            .catch(() => {})
            .then(() => setDecodedSrc(src));
        }}
        onError={() => setFailedSrc(src)}
        className={cn(className, !decoded && "opacity-0", failedSrc === src && "invisible")}
      />
    </>
  );
}

// transparent 1×1 GIF: Android WebView's gray "play" poster never shows while the first frame decodes
const BLANK_POSTER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** just-sent video's first frame: skeleton at once, then the decoded frame (shared with the send tray) */
function LocalPreviewVideo({ local, className, onLoaded }: { local: string; className: string; onLoaded: () => void }) {
  return <VideoFirstFrame src={`${local}#t=0.1`} className={cn(className, "ol-chat-video")} onLoaded={onLoaded} testId="media-local-video" />;
}

/**
 * Inline playback in the chat. GIF loops and real videos both play muted + inline (playsInline / webkit-playsinline,
 * so Android WebView, iOS WKWebView/Safari and desktop all allow autoplay) while on screen, one at a time, and pause
 * off screen, under the full-screen viewer (exclusive playback) and on data saver. There is no play badge: the first
 * decoded frame shows while it buffers (and stays if autoplay is refused, e.g. iOS Low Power Mode); a tap opens the
 * viewer with sound.
 */
export function inlineVideoSrc(a: Pick<MediaAttachment, "gif" | "status">, urls: { full?: string } | null | undefined): string | undefined {
  if (a.status === "processing") return undefined;
  return urls?.full;
}

function InlineVideo({ a, urls }: { a: MediaAttachment; urls: ReturnType<typeof useMediaUrls> }) {
  // the observer watches an always-mounted wrapper: the <video> itself only mounts once the signed URL arrives,
  // and an observer bound to the earlier placeholder never fired again (the video sat at readyState 0 forever)
  const [ref, visible] = useInView<HTMLSpanElement>("0px", true);
  const vref = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const src = inlineVideoSrc(a, urls);
  const allowed = !saveData();
  useEffect(() => {
    const on = (e: Event) => setBlocked(!!(e as CustomEvent<{ active: boolean }>).detail?.active);
    window.addEventListener(PLAYBACK_EVENT, on);
    setBlocked(exclusivePlaying());
    return () => window.removeEventListener(PLAYBACK_EVENT, on);
  }, []);
  const mediaEl = !!src && allowed && !(a.gif && (a.mime === "image/gif" || src.includes("/original")));
  useEffect(() => {
    const v = vref.current;
    if (!v) return;
    if (visible && src && allowed && !blocked) {
      v.muted = true;
      v.defaultMuted = true;
      const p = v.play();
      if (p) p.catch(() => setPlaying(false)); // Low Power Mode / autoplay refused: the first frame stays
    } else v.pause();
  }, [visible, src, allowed, blocked, mediaEl]);
  // no play badge, ever: the first decoded frame shows while it buffers; a refused autoplay keeps that frame
  const [frame, setFrame] = useState(false);
  if (!src || !allowed)
    return <span ref={ref} className="pointer-events-none absolute inset-0" aria-hidden />;
  if (a.gif && (a.mime === "image/gif" || src.includes("/original"))) {
    // GIF still converting: retain the existing thumbnail until the original GIF has decoded.
    return (
      <span ref={ref} className="pointer-events-none absolute inset-0">
        <DecodeGatedImage src={src} className="absolute inset-0 h-full w-full object-cover transition-opacity duration-200 motion-reduce:transition-none" testId="media-gif-inline" />
      </span>
    );
  }
  return (
    <span ref={ref} className="pointer-events-none absolute inset-0">
      <video
        ref={vref}
        src={visible ? `${src}${src.includes("#") ? "" : "#t=0.001"}` : undefined}
        poster={BLANK_POSTER}
        muted
        autoPlay={visible && !blocked}
        playsInline
        loop
        preload={visible ? "auto" : "none"}
        disablePictureInPicture
        disableRemotePlayback
        onLoadedData={() => setFrame(true)}
        onPlaying={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        data-testid={a.gif ? "media-gif-video" : "media-inline-video"}
        data-playing={playing ? "1" : "0"}
        className={cn("ol-chat-video pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-200", playing || frame ? "opacity-100" : "opacity-0")}
        // eslint-disable-next-line react/no-unknown-property
        {...{ "webkit-playsinline": "true", "x5-playsinline": "true" }}
      />
    </span>
  );
}

// ---------- documents ----------
const FAMILY_STYLE: Record<ReturnType<typeof docFamily>, { icon: typeof FileIcon; bg: string }> = {
  pdf: { icon: FileText, bg: "bg-red-500" },
  image: { icon: FileImage, bg: "bg-violet-500" },
  video: { icon: FileVideo, bg: "bg-pink-500" },
  audio: { icon: FileAudio, bg: "bg-orange-500" },
  archive: { icon: FileArchive, bg: "bg-amber-600" },
  sheet: { icon: FileSpreadsheet, bg: "bg-green-600" },
  slides: { icon: Presentation, bg: "bg-orange-600" },
  doc: { icon: FileText, bg: "bg-blue-500" },
  code: { icon: FileCode, bg: "bg-slate-500" },
  apk: { icon: Smartphone, bg: "bg-lime-600" },
  file: { icon: FileIcon, bg: "bg-sky-600" },
};

/** "very-long-file-name…draft.pdf": keep the extension visible */
function middleTruncate(name: string, max = 34) {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : "";
  const keep = max - ext.length - 1;
  return name.slice(0, Math.ceil(keep * 0.7)) + "…" + name.slice(name.length - ext.length - Math.floor(keep * 0.3));
}

function DocumentTile({ m, a, mine, onRetry }: { m: Msg; a: MediaAttachment; mine: boolean; onRetry?: (m: Msg) => void }) {
  const outbox = useOutbox(m.clientId);
  const name = a.name || "File";
  const fam = docFamily(name, a.mime);
  const style = FAMILY_STYLE[fam];
  const Icon = style.icon;
  const ext = (name.split(".").pop() ?? "").slice(0, 5).toUpperCase();
  const [dl, setDl] = useState<number | null>(null);
  const [ref, near] = useInView<HTMLDivElement>("400px");
  const urls = useMediaUrls(a.thumb ? a : undefined, near);
  const uploading = !!outbox && outbox.phase !== "done" && outbox.phase !== "failed";
  const failed = m.state === "failed" || outbox?.phase === "failed";
  const abort = useRef<AbortController | null>(null);

  const open = async () => {
    if (uploading || failed || m.id.startsWith("local-")) return;
    if (dl !== null) {
      abort.current?.abort();
      return;
    }
    const inline = a.mime === "application/pdf" || (a.mime.startsWith("image/") && a.thumb);
    if (inline) {
      openViewer({ message: m, from: null, mode: a.mime === "application/pdf" ? "pdf" : "visual" });
      return;
    }
    const u = await getUrls(a, true);
    if (!u.full) return;
    await downloadFile(u.full, name, a.mime, a.size, setDl, (abort.current = new AbortController()));
  };

  return (
    <div ref={ref} className="flex items-center gap-3 px-2.5 py-2.5" data-testid="media-document">
      <button
        type="button"
        onClick={uploading ? () => m.clientId && cancelMedia(m.clientId) : failed ? () => onRetry?.(m) : open}
        aria-label={uploading ? "Cancel upload" : failed ? "Retry" : dl !== null ? "Cancel download" : `Open ${name}`}
        className={cn("relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl text-white", urls?.thumb ? "bg-zinc-700" : style.bg)}
      >
        {!uploading && !failed && (
          <span className="relative flex flex-col items-center">
            <Icon className="h-5 w-5" />
            {ext && <span className="mt-0.5 text-[8.5px] leading-none font-bold tracking-wide">{ext}</span>}
          </span>
        )}
        {urls?.thumb && !uploading && !failed && <DecodeGatedImage src={urls.thumb} placeholder={a.ph} className="absolute inset-0 h-full w-full object-cover transition-opacity duration-200 motion-reduce:transition-none" testId="media-document-thumb" />}
        {uploading || dl !== null ? (
          <ProgressRing value={uploading ? (outbox!.phase === "uploading" ? outbox!.progress : undefined) : dl!} size={40} stroke={2.5} className="relative bg-black/30 rounded-full">
            <X className="h-4 w-4" />
          </ProgressRing>
        ) : failed ? (
          <RotateCw className="relative h-5 w-5" />
        ) : null}
      </button>
      <button type="button" onClick={open} className="min-w-0 flex-1 text-left" tabIndex={-1}>
        <div className="truncate text-[14.5px] leading-tight font-semibold" title={name}>
          {middleTruncate(name)}
        </div>
        <div className={cn("mt-0.5 flex items-center gap-1 text-[12px] tabular-nums", mine ? "text-on-accent/75" : "text-zinc-400")}>
          {uploading ? (
            outbox!.phase === "uploading" ? `${formatBytes(Math.round(outbox!.progress * a.size))} / ${formatBytes(a.size)}` : "Processing…"
          ) : dl !== null ? (
            `${formatBytes(Math.round(dl * a.size))} / ${formatBytes(a.size)}`
          ) : failed ? (
            outbox?.error ?? "Not sent · tap to retry"
          ) : (
            <>
              {formatBytes(a.size)}
              {ext && ` · ${ext}`}
              {!inNativeApp() && a.mime !== "application/pdf" && <Download className="ml-1 h-3 w-3" />}
            </>
          )}
        </div>
      </button>
      {(a.expiresAt || a.viewOnce) && <InlineExpiry a={a} />}
    </div>
  );
}

function InlineExpiry({ a }: { a: MediaAttachment }) {
  const left = a.expiresAt ? a.expiresAt - serverNow() : 0;
  const frac = a.ttl && a.expiresAt ? left / (a.ttl * 1000) : 1;
  return (
    <span className="flex shrink-0 items-center gap-1 text-[11px] font-semibold tabular-nums opacity-80" title={expiryInfo(a) ?? ""} data-testid="media-expiry">
      <CountdownRing left={frac} size={14} /> {a.expiresAt ? formatBadge(left) : ""}
    </span>
  );
}

/**
 * Download with a progress ring. Native apps get the signed https URL (Android DownloadManager / iOS Quick Look via
 * the bridge when present; otherwise the WebView's own download handling). Browsers stream it with progress.
 */
async function downloadFile(url: string, name: string, mime: string, size: number, setDl: (v: number | null) => void, ctrl: AbortController) {
  const dlUrl = url + (url.includes("?") ? "&" : "?") + "dl=1";
  const n = mediaNative();
  if (n?.openFile) {
    n.openFile(new URL(dlUrl, location.href).href, name, mime);
    return;
  }
  if (inNativeApp() || size > 150 * 1024 * 1024 || typeof ReadableStream === "undefined") {
    const link = document.createElement("a");
    link.href = dlUrl;
    link.download = name;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    return;
  }
  setDl(0);
  try {
    const res = await fetch(dlUrl, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(String(res.status));
    const total = Number(res.headers.get("content-length")) || size;
    const reader = res.body.getReader();
    const parts: BlobPart[] = [];
    let got = 0;
    let last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value as BlobPart);
      got += value.length;
      if (got - last > total / 100) {
        last = got;
        setDl(got / total);
      }
    }
    const blob = new Blob(parts, { type: mime || "application/octet-stream" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  } catch {
    // aborted or failed: nothing to clean up
  } finally {
    setDl(null);
  }
}

// ---------- voice notes ----------
function decodeWave(b64?: string): number[] {
  if (!b64) return Array.from({ length: 48 }, () => 0.15);
  try {
    const bin = atob(b64);
    return Array.from(bin, (c) => c.charCodeAt(0) / 255);
  } catch {
    return Array.from({ length: 48 }, () => 0.15);
  }
}

/** resample 64 peaks to `n` bars */
function bars(wave: number[], n: number) {
  if (wave.length === n) return wave;
  return Array.from({ length: n }, (_, i) => {
    const a = (i * wave.length) / n;
    const b = ((i + 1) * wave.length) / n;
    let mx = 0;
    for (let j = Math.floor(a); j < Math.max(Math.floor(a) + 1, Math.ceil(b)); j++) mx = Math.max(mx, wave[j] ?? 0);
    return mx;
  });
}

function VoiceTile({ m, a, mine, onRetry }: { m: Msg; a: MediaAttachment; mine: boolean; onRetry?: (m: Msg) => void }) {
  const outbox = useOutbox(m.clientId);
  const local = m.id.startsWith("local-");
  const p = useVoiceState(a.id);
  const durS = (a.durMs ?? 0) / 1000;
  const wave = useMemo(() => bars(decodeWave(a.wave), 40), [a.wave]);
  const uploading = !!outbox && outbox.phase !== "done" && outbox.phase !== "failed";
  const failed = m.state === "failed" || outbox?.phase === "failed";
  const unplayed = !a.playedAt && !local;
  const isCurrent = p.id === a.id;
  const pos = isCurrent ? p.position : 0;
  const frac = durS ? Math.min(1, pos / (p.duration || durS)) : 0;
  const track = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (local) return;
    return registerVoice({
      id: a.id,
      durationS: durS,
      resolveUrl: async () => (await getUrls(a)).full ?? null,
      onStart: () => {
        if (!mine && !a.playedAt) void markPlayed(a.id);
      },
    });
  }, [a, durS, local, mine]);

  const toggle = useCallback(() => {
    if (local) return;
    if (isCurrent && p.playing) pauseVoice();
    else void playVoice(a.id);
  }, [a.id, isCurrent, p.playing, local]);

  const scrub = (clientX: number) => {
    const el = track.current;
    if (!el || local) return;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    seekVoice(a.id, f * (p.duration || durS));
  };

  const fg = mine ? "bg-[var(--color-on-accent,#04120a)]" : "bg-emerald-400";
  const bgBar = mine ? "bg-black/25" : "bg-zinc-500/60";
  return (
    <div className="flex items-center gap-2.5 px-2.5 py-2" data-voice-id={local ? undefined : a.id} data-testid="media-voice">
      <button
        type="button"
        onClick={uploading ? () => m.clientId && cancelMedia(m.clientId) : failed ? () => onRetry?.(m) : toggle}
        aria-label={uploading ? "Cancel" : failed ? "Retry" : isCurrent && p.playing ? "Pause voice message" : "Play voice message"}
        className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-full", mine ? "bg-black/15" : "bg-emerald-500 text-on-accent")}
      >
        {uploading ? (
          <ProgressRing value={outbox!.phase === "uploading" ? outbox!.progress : undefined} size={36} stroke={2.5}>
            <X className="h-4 w-4" />
          </ProgressRing>
        ) : failed ? (
          <RotateCw className="h-4 w-4" />
        ) : isCurrent && p.loading ? (
          <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        ) : isCurrent && p.playing ? (
          <Pause className="h-4 w-4 fill-current" />
        ) : (
          <Play className="ml-0.5 h-4 w-4 fill-current" />
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div
          ref={track}
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(durS)}
          aria-valuenow={Math.round(pos)}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            scrub(e.clientX);
          }}
          onPointerMove={(e) => e.buttons && scrub(e.clientX)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") seekVoice(a.id, Math.min(durS, pos + 5));
            if (e.key === "ArrowLeft") seekVoice(a.id, Math.max(0, pos - 5));
          }}
          className="flex h-7 cursor-pointer touch-none items-center gap-[2px]"
        >
          {wave.map((v, i) => (
            <span key={i} className={cn("w-[2.5px] min-w-[2px] flex-1 rounded-full", i / wave.length < frac ? fg : bgBar)} style={{ height: `${Math.max(12, Math.round(v * 100))}%` }} />
          ))}
        </div>
        <div className={cn("mt-0.5 flex items-center gap-1.5 text-[11.5px] font-medium tabular-nums", mine ? "text-on-accent/75" : "text-zinc-400")}>
          <span>{formatDuration((isCurrent && (p.playing || pos > 0) ? pos : durS) * 1000)}</span>
          {unplayed && <span className={cn("h-1.5 w-1.5 rounded-full", mine ? "bg-black/40" : "bg-emerald-400")} aria-label="Not played yet" data-testid="voice-unplayed" />}
          {(a.expiresAt || a.viewOnce) && <InlineExpiry a={a} />}
        </div>
      </div>
      {!local && (
        <button
          type="button"
          onClick={cycleRate}
          aria-label={`Playback speed ${p.rate}x`}
          className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums", mine ? "bg-black/15" : "bg-zinc-700 text-zinc-200")}
        >
          {p.rate}x
        </button>
      )}
    </div>
  );
}

// ---------- gone ----------
function GoneTile({ a, mine, shape }: { a: MediaAttachment; mine: boolean; shape: string }) {
  const Icon = a.gone?.reason === "deleted" ? Trash2 : a.viewOnce ? Eye : a.kind === "photo" || a.kind === "video" ? Flame : Timer;
  return (
    <div
      className={cn("flex items-center gap-2 px-3.5 py-2 text-[14px] italic", shape, mine ? "bg-emerald-500/25 text-zinc-200" : "bg-zinc-800/70 text-zinc-400")}
      data-testid="media-gone"
      data-reason={a.gone?.reason ?? "expired"}
    >
      <Icon className="h-4 w-4 shrink-0 not-italic opacity-80" />
      {goneLabel(a)}
    </div>
  );
}
