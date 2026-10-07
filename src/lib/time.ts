// Time, Telegram-style.
//
// - The server is the source of truth: every timestamp the app shows is a server-issued epoch-ms (UTC) value
//   (createdAt, readAt, lastSeenAt, room createdAt…). The client never invents timestamps for stored data.
// - Clock-skew correction: the ws "ping" ack carries the server's clock; each round trip gives
//   offset = serverNow − (t0 + t1) / 2. We keep the lowest-RTT sample of the last 8 (NTP-style) and ease
//   towards it, so a phone clock that's minutes off still gets "just now" / "2m" / "Yesterday" right.
// - Display: device's *current* timezone + locale (12/24 h) via Intl.DateTimeFormat. Formatters are cached
//   per timezone and dropped when the zone changes (travel, DST rules); useClockTick() re-renders on a
//   30 s tick, on return to the foreground and when the zone or the skew estimate changes.
import { useSyncExternalStore } from "react";

const DAY_MS = 86_400_000;

// ---------------- clock-skew correction ----------------
let offset = 0;
let synced = false;
let pinned = false; // tests only: a pinned offset ignores ping samples
const samples: { offset: number; rtt: number }[] = [];

/** Feed one ping round trip: t0/t1 = local Date.now() before/after, serverNow = server's Date.now() in the ack. */
export function recordClockSample(t0: number, serverNow: unknown, t1: number) {
  if (pinned || typeof serverNow !== "number" || !Number.isFinite(serverNow) || !(t1 >= t0) || t1 - t0 > 30_000) return;
  samples.push({ offset: serverNow - (t0 + t1) / 2, rtt: t1 - t0 });
  if (samples.length > 8) samples.shift();
  const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  const before = offset;
  // first sample or a big jump (phone clock changed) → adopt it; otherwise smooth out jitter
  offset = !synced || Math.abs(best.offset - offset) > 2_000 ? best.offset : offset + (best.offset - offset) * 0.3;
  synced = true;
  if (Math.abs(offset - before) > 1_000) bump();
}

/** Server-corrected "now" (epoch ms). Use it for anything compared with server timestamps. */
export function serverNow() {
  return Date.now() + offset;
}

export function clockInfo() {
  return { offset: Math.round(offset), synced, samples: samples.length, pinned };
}

/** Tests only (display-only effect): pin the offset, e.g. to put "now" a few seconds before local midnight. */
function pinClockOffset(ms: number | null) {
  pinned = ms !== null;
  if (ms !== null) offset = ms;
  bump();
  schedule();
}

if (typeof window !== "undefined") {
  Object.defineProperty(window, "__openloungeClock", { configurable: true, get: () => ({ ...clockInfo(), pin: pinClockOffset }) });
}

// ---------------- formatting (device timezone + locale) ----------------
function currentZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}
let zone = currentZone();
const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(name: string, opts: Intl.DateTimeFormatOptions) {
  let f = formatters.get(name);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, opts);
    formatters.set(name, f);
  }
  return f;
}
/** Re-read the device timezone; true (and caches dropped) if it changed. */
export function checkTimezone() {
  const z = currentZone();
  if (z === zone) return false;
  zone = z;
  formatters.clear();
  return true;
}

/** Calendar days between ts and now in the device's zone (0 = today, 1 = yesterday, <0 = future). DST-safe. */
export function dayDiff(ts: number, now = serverNow()) {
  const a = new Date(ts), b = new Date(now);
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db - da) / DAY_MS);
}
const sameYear = (ts: number, now: number) => new Date(ts).getFullYear() === new Date(now).getFullYear();

/** "9:24 PM" / "21:24" per locale. */
export function formatClock(ts: number) {
  return fmt("clock", { hour: "numeric", minute: "2-digit" }).format(ts);
}

/** Inbox / list stamp: today → "9:24 PM", yesterday → "Yesterday", < 7 days → "Mon", older → "Sep 4" (+ year). */
export function formatListTime(ts: number, now = serverNow()) {
  const d = dayDiff(ts, now);
  if (d <= 0) return formatClock(ts);
  if (d === 1) return "Yesterday";
  if (d < 7) return fmt("wday", { weekday: "short" }).format(ts);
  return sameYear(ts, now) ? fmt("md", { month: "short", day: "numeric" }).format(ts) : fmt("ymd", { year: "numeric", month: "short", day: "numeric" }).format(ts);
}

/** Day separator in a thread: "Today", "Yesterday", "Monday", "September 4" (+ year). */
export function formatDaySeparator(ts: number, now = serverNow()) {
  const d = dayDiff(ts, now);
  if (d <= 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 7) return fmt("wdayLong", { weekday: "long" }).format(ts);
  return sameYear(ts, now) ? fmt("mdLong", { month: "long", day: "numeric" }).format(ts) : fmt("ymdLong", { year: "numeric", month: "long", day: "numeric" }).format(ts);
}

/** "just now", "5m", "3h", "2d" against the server-corrected clock (a future stamp from skew reads "just now"). */
export function formatAgo(ts: number, now = serverNow()) {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Tooltip / long-press: full local date-time with zone, plus UTC. */
export function formatFull(ts: number) {
  const local = fmt("full", { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(ts);
  const utc = new Date(ts).toISOString().slice(0, 16).replace("T", " ");
  return `${local} · ${utc} UTC`;
}

// ---------------- re-render tick ----------------
export const TICK_MS = 30_000;
let tick = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
function bump() {
  tick++;
  for (const l of listeners) l();
}
function schedule() {
  if (timer) clearTimeout(timer);
  if (!listeners.size) return;
  // next 30 s boundary of the corrected clock (+50 ms so the label has flipped) — "Active 5m ago" ticks live
  const n = serverNow();
  timer = setTimeout(() => {
    checkTimezone();
    bump();
    schedule();
  }, TICK_MS - (n % TICK_MS) + 50);
}
function onWake() {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  checkTimezone();
  bump();
  schedule(); // timers were throttled / frozen in the background
}
function subscribe(l: () => void) {
  listeners.add(l);
  if (listeners.size === 1 && typeof window !== "undefined") {
    schedule();
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("openlounge:native-visibility", onWake);
  }
  return () => {
    listeners.delete(l);
    if (!listeners.size && typeof window !== "undefined") {
      if (timer) clearTimeout(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("openlounge:native-visibility", onWake);
    }
  };
}
/** Force every useClockTick() consumer to re-render now (presence events, clock resync). */
export function bumpClock() {
  bump();
}
/** Re-render every 30 s, on every presence event, on foreground/focus, and when the timezone or clock-skew estimate changes. */
export function useClockTick() {
  return useSyncExternalStore(
    subscribe,
    () => tick,
    () => 0,
  );
}
