import { formatAgo } from "./time";

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** "just now", "5m", "3h", "2d" against the server-corrected clock (see lib/time.ts). */
export function timeAgo(ts: number) {
  return formatAgo(ts);
}

export function compact(n: number) {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
  if (n < 1_000_000) return Math.round(n / 1000) + "K";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

export function cn(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(" ");
}

export const TOPIC_EMOJI: Record<string, string> = {
  Tech: "💻",
  Startups: "🚀",
  Music: "🎵",
  Wellness: "🌿",
  Culture: "🎭",
  Design: "🎨",
  Gaming: "🎮",
  Sports: "🏀",
  Other: "✨",
};
