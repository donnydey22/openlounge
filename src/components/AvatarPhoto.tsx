"use client";

import { useEffect, useState } from "react";
import { cn, initials } from "@/lib/utils";

/**
 * Photo thumbnail: the gradient + initials stay underneath as the placeholder (fixed box, so no layout shift),
 * the image loads lazily/off-main-thread and fades in once decoded; a broken URL just leaves the initials.
 */
const loadedPhotos = new Set<string>();
export function AvatarPhoto({ src, name }: { src: string; name: string }) {
  const [state, setState] = useState<"loading" | "ok" | "error">(() => (loadedPhotos.has(src) ? "ok" : "loading"));
  useEffect(() => setState(loadedPhotos.has(src) ? "ok" : "loading"), [src]);
  return (
    <>
      {state !== "ok" && <span className="relative z-[1]">{initials(name)}</span>}
      {state !== "error" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => {
            loadedPhotos.add(src);
            setState("ok");
          }}
          onError={() => setState("error")}
          ref={(el) => {
            // cached images can finish before React attaches onLoad
            if (el?.complete && el.naturalWidth > 0 && !loadedPhotos.has(src)) {
              loadedPhotos.add(src);
              queueMicrotask(() => setState("ok"));
            }
          }}
          className={cn(
            "openlounge-hex absolute inset-0 z-[2] h-full w-full object-cover transition-opacity duration-200 motion-reduce:transition-none",
            state === "ok" ? "opacity-100" : "opacity-0",
          )}
        />
      )}
    </>
  );
}
