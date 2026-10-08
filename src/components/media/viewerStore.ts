"use client";
// Which attachment is open full-screen (photo/video viewer or PDF viewer). Bubbles open it; MediaLayer renders it.
import { useSyncExternalStore } from "react";
import type { DirectMessage } from "@/lib/types";

export interface ViewerTarget {
  message: DirectMessage;
  /** view once: URL from /open (single use) */
  viewOnceUrls?: { full?: string; poster?: string };
  /** the tile's bounding box: the viewer zooms out of it (Telegram) */
  from?: DOMRect | null;
  mode: "visual" | "pdf";
  /** albums: which item was tapped */
  index?: number;
}

let target: ViewerTarget | null = null;
const subs = new Set<() => void>();

export function openViewer(t: ViewerTarget) {
  target = t;
  subs.forEach((s) => s());
}
export function closeViewer() {
  target = null;
  subs.forEach((s) => s());
}
export function useViewer() {
  return useSyncExternalStore(
    (cb) => (subs.add(cb), () => subs.delete(cb)),
    () => target,
    () => null,
  );
}
