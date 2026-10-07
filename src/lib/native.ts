// Optional native bridge (Android WebView: window.OpenLoungeNative; iOS Expo WebView: same shape injected).
// Everything is feature-detected; the web app works without it.
export interface OpenLoungeNativeBridge {
  getPushToken?(): string; // "" until FCM hands one out
  getPlatform?(): string; // "android" | "ios"
  share?(text: string, url: string): void;
  /** shows the OS permission prompt if needed; result comes back via window.__olContacts(json) */
  requestContacts?(): void;
  contactsPermission?(): string; // "granted" | "denied" | "prompt"
  openAppSettings?(): void;
  requestNotificationPermission?(): void;
  /** iOS RN WebView fallback */
  postMessage?(s: string): void;
}

export function native(): OpenLoungeNativeBridge | null {
  if (typeof window === "undefined") return null;
  const n = (window as unknown as { OpenLoungeNative?: OpenLoungeNativeBridge }).OpenLoungeNative;
  return n ?? null;
}

export const nativePlatform = (): "android" | "ios" | null => {
  const p = native()?.getPlatform?.();
  return p === "android" || p === "ios" ? p : null;
};

export const hasNativeContacts = () => typeof native()?.requestContacts === "function";

export interface NativeContact {
  name: string;
  numbers: string[];
}

/** Ask the native wrapper for contacts (OS prompt first). Resolves null if declined/unavailable. */
export function readNativeContacts(timeoutMs = 60_000): Promise<{ contacts: NativeContact[]; country: string } | null> {
  const n = native();
  if (!n?.requestContacts) return Promise.resolve(null);
  return new Promise((resolve) => {
    const w = window as unknown as { __olContacts?: (json: string) => void };
    const t = setTimeout(() => resolve(null), timeoutMs);
    w.__olContacts = (json: string) => {
      clearTimeout(t);
      try {
        const j = JSON.parse(json);
        resolve(j && j.granted ? { contacts: j.contacts ?? [], country: String(j.country || "US").toUpperCase() } : null);
      } catch {
        resolve(null);
      }
    };
    n.requestContacts!();
  });
}

/** Native share sheet → navigator.share → clipboard. Returns how it was shared. */
export async function shareLink(text: string, url: string): Promise<"native" | "web" | "copied" | "failed"> {
  const n = native();
  if (n?.share) {
    n.share(text, url);
    return "native";
  }
  try {
    if (navigator.share) {
      await navigator.share({ text, url });
      return "web";
    }
  } catch (e) {
    if ((e as Error).name === "AbortError") return "failed";
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`.trim());
    return "copied";
  } catch {
    return "failed";
  }
}
