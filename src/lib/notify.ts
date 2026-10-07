// Browser Web Notifications (no push server, no Firebase): while the app is open in a tab
// (or a Home Screen web app) we show native OS notifications when that tab is hidden, and
// in-app banners when it's visible. Everything here is feature-detected and wrapped in
// try/catch: unsupported browsers (Android APK WebView, iOS WKWebView, old Safari, …) just
// never see a prompt, and nothing throws.

export type NotifSupport =
  | "supported" // Notification API available
  | "ios-install" // iPhone/iPad Safari tab: only Home Screen web apps (iOS 16.4+) get notifications
  | "unsupported";

export type NotifChoice = "enabled" | "disabled" | "later" | "denied";
interface Pref {
  choice: NotifChoice;
  at: number;
}

const PREF_KEY = "openlounge:notifications";
/** "Not now" → ask again after this long */
export const REASK_AFTER_MS = 7 * 24 * 60 * 60_000;
export const ICON = "/icons/icon-192.png";
const BADGE = "/icons/badge-96.png";

const isBrowser = () => typeof window !== "undefined" && typeof navigator !== "undefined";

function ua() {
  return isBrowser() ? navigator.userAgent || "" : "";
}

/** Our Android APK wraps the site in a WebView and tags its user agent. */
export function isAndroidApp() {
  return /OpenLoungeAndroid/.test(ua());
}

export function isIOS() {
  if (!isBrowser()) return false;
  const u = ua();
  // iPadOS 13+ reports as Macintosh; tell it apart by touch support
  return /iPad|iPhone|iPod/.test(u) || (/Macintosh/.test(u) && (navigator.maxTouchPoints ?? 0) > 1);
}

export function isStandalone() {
  if (!isBrowser()) return false;
  try {
    return (
      window.matchMedia?.("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
  } catch {
    return false;
  }
}

function iosVersion(): number | null {
  const m = ua().match(/OS (\d+)[_.](\d+)/);
  if (m) return Number(m[1]) + Number(m[2]) / 100;
  const v = ua().match(/Version\/(\d+)\.(\d+)/); // iPadOS desktop-mode UA
  return v ? Number(v[1]) + Number(v[2]) / 100 : null;
}

export function getSupport(): NotifSupport {
  if (!isBrowser()) return "unsupported";
  try {
    if (isAndroidApp()) return "unsupported";
    if ("Notification" in window && typeof window.Notification === "function") return "supported";
    if (isIOS() && !isStandalone()) {
      // An in-app WKWebView (no "Safari/" token in the UA) can never be added to the Home Screen.
      if (!/Safari\//.test(ua())) return "unsupported";
      const v = iosVersion();
      if (v === null || v >= 16.04) return "ios-install";
    }
  } catch {
    /* fall through */
  }
  return "unsupported";
}

export function getPermission(): NotificationPermission | "unsupported" {
  try {
    if (isBrowser() && "Notification" in window && typeof window.Notification === "function") return Notification.permission;
  } catch {
    /* ignore */
  }
  return "unsupported";
}

// ---------- preference (localStorage) + tiny subscribe store for React ----------

const listeners = new Set<() => void>();
let version = 0;
function changed() {
  version++;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}
export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function getVersion() {
  return version;
}

export function readPref(): Pref | null {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Pref;
    if (p && typeof p.choice === "string" && typeof p.at === "number") return p;
  } catch {
    /* ignore */
  }
  return null;
}

export function writePref(choice: NotifChoice) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ choice, at: Date.now() } satisfies Pref));
  } catch {
    /* private mode etc. */
  }
  changed();
}

/** OS notifications will actually be shown (permission granted and the user hasn't switched them off). */
export function osEnabled() {
  if (getSupport() !== "supported" || getPermission() !== "granted") return false;
  const p = readPref();
  return !p || p.choice === "enabled" || p.choice === "later"; // granted elsewhere (e.g. site settings) counts as on unless turned off here
}

/** Should the in-app "turn on notifications?" card be shown right now? */
export function shouldPrompt(now = Date.now()): boolean {
  const support = getSupport();
  if (support === "unsupported") return false;
  const pref = readPref();
  if (support === "supported") {
    const perm = getPermission();
    if (perm !== "default") return false; // granted (nothing to ask) or denied (never nag)
  }
  if (!pref) return true;
  if (pref.choice === "later") return now - pref.at >= REASK_AFTER_MS;
  return false;
}

/** Must be called from a user gesture (the Enable tap). Resolves to the resulting permission. */
export async function requestPermission(): Promise<NotificationPermission | "unsupported"> {
  if (getSupport() !== "supported") return "unsupported";
  let result: NotificationPermission = "default";
  try {
    const r = Notification.requestPermission() as Promise<NotificationPermission> | undefined;
    if (r && typeof r.then === "function") result = await r;
    else {
      // very old Safari: callback-only API, the promise is missing — wait for the answer
      for (let i = 0; i < 120 && Notification.permission === "default"; i++) await new Promise((res) => setTimeout(res, 500));
      result = Notification.permission;
    }
  } catch {
    const p = getPermission();
    result = p === "unsupported" ? "default" : p;
  }
  if (result === "granted") {
    writePref("enabled");
    void registerServiceWorker();
  } else if (result === "denied") writePref("denied");
  else changed();
  return result;
}

// ---------- service worker ----------

let swPromise: Promise<ServiceWorkerRegistration | null> | null = null;

/** Registers /sw.js (notifications only — no fetch handler, no caching). Never throws. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (swPromise) return swPromise;
  swPromise = (async () => {
    try {
      if (!isBrowser() || getSupport() !== "supported") return null;
      if (!("serviceWorker" in navigator) || !window.isSecureContext) return null;
      return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    } catch {
      return null;
    }
  })();
  return swPromise;
}

async function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  try {
    const reg = await registerServiceWorker();
    if (!reg) return null;
    if (reg.active) return reg;
    // first install: wait briefly for it to activate
    const ready = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ]);
    return ready ?? null;
  } catch {
    return null;
  }
}

export interface OsNotice {
  title: string;
  body?: string;
  /** collapses duplicates: a new notice with the same tag replaces the old one */
  tag: string;
  /** where a click should take the user */
  url: string;
  icon?: string;
  /** re-alert (sound/vibrate) when replacing a notice with the same tag */
  renotify?: boolean;
}

/** Hook for tests: every OS notification we attempt is also reported here. */
declare global {
  interface Window {
    __olNotifyLog?: { title: string; body?: string; tag: string; url: string; via: string }[];
  }
}

type NavigateFn = (url: string) => void;
let navigate: NavigateFn = (url) => {
  try {
    window.location.assign(url);
  } catch {
    /* ignore */
  }
};
export function setNavigator(fn: NavigateFn) {
  navigate = fn;
}

/** Show a native OS notification (SW first — required on Android Chrome — then `new Notification`). */
export async function showOsNotification(n: OsNotice): Promise<boolean> {
  if (!osEnabled()) return false;
  const opts: NotificationOptions & { renotify?: boolean } = {
    body: n.body,
    tag: n.tag,
    icon: n.icon || ICON,
    badge: BADGE,
    data: { url: n.url },
    renotify: !!n.renotify,
    silent: false,
  };
  try {
    const reg = await swRegistration();
    if (reg && typeof reg.showNotification === "function") {
      await reg.showNotification(n.title, opts);
      log(n, "sw");
      return true;
    }
  } catch {
    /* fall back below */
  }
  try {
    const notif = new Notification(n.title, opts);
    notif.onclick = (e) => {
      try {
        e.preventDefault();
        window.focus();
        notif.close();
        navigate(n.url);
      } catch {
        /* ignore */
      }
    };
    log(n, "window");
    return true;
  } catch {
    return false; // e.g. Android Chrome without a SW: `new Notification` throws
  }
}

function log(n: OsNotice, via: string) {
  try {
    (window.__olNotifyLog ??= []).push({ title: n.title, body: n.body, tag: n.tag, url: n.url, via });
  } catch {
    /* ignore */
  }
}

export function pageHidden() {
  try {
    return typeof document !== "undefined" && document.visibilityState === "hidden";
  } catch {
    return false;
  }
}

/** Short, platform-aware "how to unblock" hint for the denied state. */
export function unblockHint(): string {
  const u = ua();
  if (isIOS()) return "Open the iPhone Settings app → Notifications → Open Lounge, and allow notifications.";
  if (/Android/.test(u)) return "Tap the icon left of the address bar → Permissions → Notifications → Allow, then reload.";
  if (/Firefox\//.test(u)) return "Click the icon left of the address bar, clear the “Blocked” notifications setting, then reload.";
  if (/Safari\//.test(u) && !/Chrome\/|Chromium\/|Edg\//.test(u)) return "Safari → Settings → Websites → Notifications, set this site to Allow, then reload.";
  return "Click the icon left of the address bar → Site settings → Notifications → Allow, then reload.";
}

/**
 * Open an in-app URL from a notification or banner. While you're in a room, a DM link opens the
 * room's DM drawer instead of navigating away (navigating would make you leave the room).
 */
export const OPEN_DM_EVENT = "openlounge:open-dm";
export function routeTo(url: string, push: (href: string) => void) {
  try {
    const target = new URL(url, window.location.origin);
    if (target.origin !== window.location.origin) return;
    const dm = target.pathname.match(/^\/messages\/([^/]+)$/);
    if (dm && window.location.pathname.startsWith("/room/")) {
      window.dispatchEvent(new CustomEvent(OPEN_DM_EVENT, { detail: { peerId: decodeURIComponent(dm[1]) } }));
      return;
    }
    if (target.pathname + target.search !== window.location.pathname + window.location.search) push(target.pathname + target.search);
  } catch {
    /* ignore */
  }
}
