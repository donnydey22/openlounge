"use client";

import { memo, useEffect, useRef, useState } from "react";
import { Link2, Play, X } from "lucide-react";
import { authFetch } from "@/lib/auth";
import { firstPreviewableLink, type LinkToken } from "@/lib/linkify";
import { Thumb } from "@/components/Thumb";
import { openLinkConfirm } from "./LinkConfirm";
import { cn } from "@/lib/utils";

type Preview = { url: string; site: string; title: string; description: string; image: { src: string; w: number; h: number; blur: string } | null; video?: boolean };

// one request per URL for the whole session (re-renders, re-mounts and the same link in many bubbles share it)
const cache = new Map<string, Promise<Preview | null>>();
const settled = new Map<string, Preview | null>();
function load(url: string): Promise<Preview | null> {
  let p = cache.get(url);
  if (!p) {
    p = authFetch(`/lp/preview?url=${encodeURIComponent(url)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { preview?: Preview | null } | null) => j?.preview ?? null)
      .catch(() => null)
      .then((v) => {
        settled.set(url, v);
        return v;
      });
    cache.set(url, p);
  }
  return p;
}

/**
 * Link preview card inside a chat bubble — Telegram's treatment (accent bar, site, title, description, rounded
 * thumbnail) in Open Lounge's look. The card has a FIXED size from the first frame (skeleton → data → fallback all
 * occupy the same box), so the message list never shifts; data is fetched only when the bubble nears the screen.
 */
export const LinkPreviewCard = memo(function LinkPreviewCard({ link, tone = "default" }: { link: LinkToken; tone?: "default" | "onAccent" }) {
  const [data, setData] = useState<Preview | null | undefined>(() => (settled.has(link.href) ? settled.get(link.href) : undefined));
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (data !== undefined) return;
    let alive = true;
    const el = ref.current;
    const go = () => load(link.href).then((v) => alive && setData(v));
    if (!el || typeof IntersectionObserver === "undefined") {
      go();
      return () => {
        alive = false;
      };
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          io.disconnect();
          go();
        }
      },
      { rootMargin: "400px 0px" },
    );
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [link.href, data]);

  const onAccent = tone === "onAccent";
  const loading = data === undefined;
  const site = data?.site || link.host.replace(/^www\./, "");
  const title = data?.title || (data === null ? decodeURIComponentSafe(pathOf(link.href)) || site : "");
  const desc = data?.description ?? "";
  return (
    <button
      ref={ref}
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        openLinkConfirm(link);
      }}
      className={cn(
        "mt-1.5 mb-0.5 flex h-[76px] w-[min(264px,calc(100vw-8.5rem))] max-w-full items-stretch gap-2.5 overflow-hidden rounded-xl py-2 pr-2 pl-0 text-left whitespace-normal [contain:layout_paint]",
        onAccent ? "bg-black/10 active:bg-black/15" : "bg-white/[0.06] active:bg-white/10",
      )}
      data-testid="link-preview"
      data-state={loading ? "loading" : data ? "ready" : "fallback"}
      aria-label={`Link preview: ${title || site}`}
    >
      <span aria-hidden className={cn("w-[3px] shrink-0 rounded-full", onAccent ? "bg-current/60" : "bg-emerald-400")} />
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-[2px] leading-tight">
        <span className={cn("truncate text-[12px] font-semibold", onAccent ? "opacity-80" : "text-emerald-400")}>{site}</span>
        {loading ? (
          <>
            <span className={cn("skeleton h-3 w-4/5 rounded", onAccent ? "bg-black/15" : "bg-white/10")} />
            <span className={cn("skeleton mt-1 h-2.5 w-3/5 rounded", onAccent ? "bg-black/10" : "bg-white/[0.07]")} />
          </>
        ) : (
          <>
            <span className="line-clamp-1 text-[13.5px] font-semibold [overflow-wrap:anywhere]">{title}</span>
            {desc ? <span className={cn("line-clamp-2 text-[12px] [overflow-wrap:anywhere]", onAccent ? "opacity-75" : "text-zinc-400")}>{desc}</span> : null}
          </>
        )}
      </span>
      <span className="relative self-center">
        <Thumb
          src={data?.image?.src}
          blur={data?.image?.blur}
          shape="squircle"
          className={cn("h-[60px] w-[60px]", onAccent ? "bg-black/10" : "bg-white/[0.06]")}
          fallback={<Link2 className={cn("h-5 w-5", onAccent ? "opacity-60" : "text-zinc-500")} />}
        />
        {data?.video && (
          <span aria-label="Video" className="absolute inset-0 grid place-items-center">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-black/55 text-white shadow">
              <Play className="ml-0.5 h-3.5 w-3.5 fill-current" />
            </span>
          </span>
        )}
      </span>
    </button>
  );
});

function pathOf(href: string) {
  try {
    const u = new URL(href);
    return (u.pathname === "/" ? "" : u.pathname).slice(0, 80);
  } catch {
    return "";
  }
}
function decodeURIComponentSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Composer link preview (Telegram-style): the first previewable link in the draft shows as a compact strip above the
 * field, with an X to dismiss it for this link. Fixed 48px height; data shares the session cache with the bubble cards.
 */
export const ComposerLinkPreview = memo(function ComposerLinkPreview({ text }: { text: string }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [debounced, setDebounced] = useState(text);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 350);
    return () => clearTimeout(t);
  }, [text]);
  const link = useMemoLink(debounced);
  const [data, setData] = useState<Preview | null | undefined>(undefined);
  useEffect(() => {
    if (!link) return;
    let alive = true;
    setData(settled.has(link.href) ? settled.get(link.href) : undefined);
    load(link.href).then((v) => alive && setData(v));
    return () => {
      alive = false;
    };
  }, [link]);
  if (!link || dismissed === link.href || data === null) return null;
  return (
    <div className="mx-1 mb-1.5 flex h-12 min-w-0 items-center gap-2.5 overflow-hidden rounded-xl bg-zinc-900/95 py-1.5 pr-1 pl-0 backdrop-blur" data-testid="composer-link-preview">
      <span aria-hidden className="h-full w-[3px] shrink-0 rounded-full bg-emerald-400" />
      <Thumb src={data?.image?.src} blur={data?.image?.blur} shape="squircle" className="h-9 w-9 bg-white/[0.06]" fallback={<Link2 className="h-4 w-4 text-zinc-500" />} />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[12px] font-semibold text-emerald-400">{data?.site || link.host.replace(/^www\./, "")}</span>
        {data === undefined ? <span className="skeleton mt-1 h-2.5 w-3/5 rounded bg-white/10" /> : <span className="truncate text-[13px]">{data.title || link.text}</span>}
      </span>
      <button type="button" onClick={() => setDismissed(link.href)} aria-label="Remove link preview" className="shrink-0 rounded-full p-2 text-zinc-400 hover:bg-white/5 hover:text-white">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
});

function useMemoLink(text: string) {
  const [link, setLink] = useState<LinkToken | null>(null);
  useEffect(() => {
    const l = text.includes(".") ? firstPreviewableLink(text) : null;
    setLink((prev) => (prev?.href === l?.href ? prev : l));
  }, [text]);
  return link;
}
