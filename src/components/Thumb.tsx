"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Telegram-style thumbnail: the box size is fixed up front (no layout shift), a tiny blurred placeholder fills it
 * immediately, and the real image is lazy-loaded/decoded off the main thread, then cross-fades in (opacity only,
 * compositor-friendly → 60fps). Falls back to `fallback` (e.g. an emoji / initials) when there is no image.
 */
export function Thumb({
  src,
  blur,
  alt = "",
  className,
  fallback,
  shape = "rounded",
  eager = false,
}: {
  src?: string | null;
  blur?: string | null;
  alt?: string;
  /** must give the box its size (e.g. "h-14 w-14") */
  className?: string;
  fallback?: React.ReactNode;
  shape?: "rounded" | "circle" | "squircle";
  eager?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const radius = shape === "circle" ? "rounded-full" : shape === "squircle" ? "openlounge-hex" : "rounded-xl";
  return (
    <span
      className={cn("relative block shrink-0 overflow-hidden bg-zinc-800 [contain:strict]", radius, className)}
      style={blur ? { backgroundImage: `url("${blur}")`, backgroundSize: "cover", backgroundPosition: "center" } : undefined}
      data-testid="thumb"
      data-loaded={loaded ? "1" : "0"}
    >
      {(!src || failed) && fallback && <span className="absolute inset-0 grid place-items-center">{fallback}</span>}
      {src && !failed && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn("absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ease-out motion-reduce:transition-none", loaded ? "opacity-100" : "opacity-0")}
        />
      )}
    </span>
  );
}
