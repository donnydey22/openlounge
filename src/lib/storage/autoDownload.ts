"use client";
// Settings → Storage & data → Media auto-download (WhatsApp/Telegram-style), per device.
// photo: load the chat thumbnail by itself; video: preload + autoplay muted inline. Off = blurred preview with a
// size pill, one tap loads it. Defaults reproduce the app's behaviour before this setting existed (everything on),
// except roaming, which only native wrappers can detect (the web never reports "roaming", so nothing changes there).
export type AutoKind = "photo" | "video";
export type NetKind = "wifi" | "cellular" | "roaming";
export type AutoPrefs = Record<NetKind, Record<AutoKind, boolean>>;

const KEY = "openlounge:auto-download";
export const AUTO_DOWNLOAD_EVENT = "openlounge:auto-download";
export const DEFAULT_AUTO: AutoPrefs = {
  wifi: { photo: true, video: true },
  cellular: { photo: true, video: true },
  roaming: { photo: true, video: false },
};

export function autoPrefs(): AutoPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<AutoPrefs> | null;
    if (!raw || typeof raw !== "object") return DEFAULT_AUTO;
    const out = structuredClone(DEFAULT_AUTO);
    for (const n of ["wifi", "cellular", "roaming"] as const) for (const k of ["photo", "video"] as const) if (typeof raw[n]?.[k] === "boolean") out[n][k] = raw[n]![k];
    return out;
  } catch {
    return DEFAULT_AUTO;
  }
}

export function setAutoPref(net: NetKind, kind: AutoKind, on: boolean) {
  const p = structuredClone(autoPrefs());
  p[net][kind] = on;
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {}
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(AUTO_DOWNLOAD_EVENT));
}

type Conn = { type?: string };
/** Native wrappers may expose getNetwork() → "wifi" | "cellular" | "roaming"; the web uses navigator.connection.type. */
export function currentNetwork(): NetKind {
  if (typeof window === "undefined") return "wifi";
  try {
    const n = (window as unknown as { OpenLoungeNative?: { getNetwork?: () => string } }).OpenLoungeNative?.getNetwork?.();
    if (n === "wifi" || n === "cellular" || n === "roaming") return n;
  } catch {}
  const t = (navigator as unknown as { connection?: Conn }).connection?.type;
  return t === "cellular" ? "cellular" : "wifi"; // unknown (Safari/Firefox) = the pre-setting behaviour
}

export function autoDownloadAllowed(kind: AutoKind, net: NetKind = currentNetwork()) {
  return autoPrefs()[net][kind];
}
