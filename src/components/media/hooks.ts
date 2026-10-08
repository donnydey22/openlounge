"use client";
import { useEffect, useRef, useState } from "react";
import { serverNow } from "@/lib/time";
import { cachedUrls, getUrls } from "@/lib/media/client";
import { mediaGone, type MediaAttachment, type MediaVariant } from "@/lib/media/types";

/** true once the element is within `margin` of the viewport (lazy-load) and while it stays there (`live`) */
export function useInView<T extends Element>(margin = "600px", live = false) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (es) => {
        const hit = es.some((e) => e.isIntersecting);
        if (hit) setInView(true);
        else if (live) setInView(false);
        if (hit && !live) io.disconnect();
      },
      { rootMargin: margin, threshold: live ? 0.5 : 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [margin, live]);
  return [ref, inView] as const;
}

type Urls = Partial<Record<MediaVariant, string>> & { gone?: boolean };

/** Signed URLs for an attachment once it's near the screen. Never asks for gone / local / view-once media. */
export function useMediaUrls(m: MediaAttachment | undefined, enabled: boolean): Urls | null {
  const id = m?.id;
  const skip = !m || !enabled || id!.startsWith("local-") || !!m.viewOnce || mediaGone(m, serverNow());
  const [urls, setUrls] = useState<Urls | null>(() => (id && !skip ? cachedUrls(id) : null));
  const status = m?.status;
  useEffect(() => {
    if (skip || !m) return;
    let alive = true;
    void getUrls(m).then((u) => alive && setUrls(u));
    // refresh before the signed URLs run out (long-open threads)
    const t = setInterval(() => void getUrls(m).then((u) => alive && setUrls(u)), 4 * 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, skip, status]);
  return skip ? null : urls;
}

/** re-render every `ms` while `active` (countdowns) */
export function useTick(active: boolean, ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
}
