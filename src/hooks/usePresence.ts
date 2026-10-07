"use client";

import { useApp } from "@/components/AppProvider";
import { timeAgo } from "@/lib/utils";
import { formatClock, formatFull, formatListTime, dayDiff, useClockTick } from "@/lib/time";

/** "Active 10:49 PM" / "Active Yesterday" — the absolute twin of lastSeenLabel, from the SAME timestamp. */
export function lastSeenAbsolute(ts: number | null | undefined): string | null {
  if (!ts) return null;
  return dayDiff(ts) <= 0 ? formatClock(ts) : formatListTime(ts);
}

/** "Active 5m ago" style label for an offline user's last-seen timestamp. */
export function lastSeenLabel(ts: number | null | undefined): string | null {
  if (!ts) return null;
  const ago = timeAgo(ts);
  return ago === "just now" ? "Active just now" : `Active ${ago} ago`;
}

/**
 * Live presence for one user: driven by the app-wide presence map that the server
 * pushes over the WebSocket (presence:snapshot / presence:update), so it updates
 * without refetching. `fallbackLastSeen` is the value from a fetched PublicUser.
 * status: green "online" (foreground), amber "away" (connected, backgrounded), "offline" (no dot).
 */
export function usePresence(userId: string | null | undefined, fallbackLastSeen?: number | null) {
  const { presenceOf, lastSeenAt } = useApp();
  const status = userId ? presenceOf(userId) : "offline";
  const online = status === "online";
  const seen = userId && !online ? lastSeenAt(userId, fallbackLastSeen) : null;
  // re-render on the shared minute tick / foreground / timezone change so "Active 5m ago" keeps counting
  useClockTick();
  return {
    online,
    /** "online" | "away" | "offline" — pass `dot` straight to <Avatar presence> */
    status,
    dot: status === "offline" ? null : status,
    lastSeenAt: seen,
    label: online ? "Online" : status === "away" ? "Away" : lastSeenLabel(seen),
    /** absolute local time of the same lastSeenAt (tooltip), so "Active 9m ago" and "10:49 PM" never disagree */
    seenAt: seen ? lastSeenAbsolute(seen) : null,
    seenTitle: seen ? formatFull(seen) : undefined,
  };
}
