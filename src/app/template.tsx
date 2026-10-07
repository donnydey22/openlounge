"use client";

import { usePathname } from "next/navigation";

/**
 * Re-mounts on every navigation, so a CSS entry animation plays per route.
 * Room opens like a Clubhouse bottom sheet; other views do a short iOS-ish slide/fade.
 * Only transform/opacity animate; no fill-mode, so no transform lingers (fixed bars stay correct).
 */
export default function Template({ children }: { children: React.ReactNode }) {
  const path = usePathname() ?? "/";
  const kind = path.startsWith("/room/") ? "route-sheet" : path === "/" ? "route-fade" : "route-push";
  return <div className={kind}>{children}</div>;
}
