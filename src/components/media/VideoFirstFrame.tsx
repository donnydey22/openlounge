"use client";
// One shared "video thumbnail before the server poster exists" component (send tray, just-sent bubbles).
// A skeleton (film icon on a soft pulse) shows at once so a tile is never blank; the clip's own first frame
// replaces it as soon as it decodes. `#t=0.001` + preload="auto" is the proven way to make iOS WKWebView/Safari
// paint a paused video's first frame (preload="metadata" never fires loadeddata there, which left the tray empty).
import { useState } from "react";
import { Film } from "lucide-react";
import { cn } from "@/lib/utils";

// transparent 1×1 GIF: Android WebView's gray "play" poster never shows while the first frame decodes
const BLANK_POSTER = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export function firstFrameSrc(url: string) {
  return url.includes("#") ? url : `${url}#t=0.001`;
}

export function VideoSkeleton({ className }: { className?: string }) {
  return (
    <span aria-hidden data-testid="video-skeleton" className={cn("pointer-events-none absolute inset-0 flex items-center justify-center bg-zinc-800 animate-pulse motion-reduce:animate-none", className)}>
      <Film className="h-7 w-7 text-zinc-500" />
    </span>
  );
}

export function VideoFirstFrame({ src, className, onLoaded, testId }: { src: string; className?: string; onLoaded?: () => void; testId?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <>
      {!shown && <VideoSkeleton />}
      <video
        src={firstFrameSrc(src)}
        poster={BLANK_POSTER}
        muted
        playsInline
        preload="auto"
        aria-hidden
        onLoadedData={() => {
          setShown(true);
          onLoaded?.();
        }}
        className={cn(className, !shown && "invisible")}
        data-testid={testId}
      />
    </>
  );
}
