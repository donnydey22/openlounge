// Push token registration. The native wrappers (Android FCM / iOS) expose the device token via
// window.OpenLoungeNative.getPushToken() and call window.__olPushToken(token) when it changes.
import { authFetch } from "./auth";
import { native, nativePlatform } from "./native";
import type { NotifPrefsClient } from "./types";

let registered: string | null = null;

async function register(token: string) {
  const platform = nativePlatform();
  if (!token || !platform || token === registered) return;
  const res = await authFetch("/api/push/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, platform }) });
  if (res.ok) {
    registered = token;
    try {
      localStorage.setItem("openlounge:pushToken", token);
    } catch {}
  }
}

/** Call after sign-in / session restore. Safe to call repeatedly. */
export function initPushRegistration() {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __olPushToken?: (t: string) => void };
  w.__olPushToken = (t: string) => void register(t).catch(() => {});
  native()?.requestNotificationPermission?.();
  const t = native()?.getPushToken?.();
  if (t) void register(t).catch(() => {});
}

/** Before sign-out: detach this device's token from the account. */
export async function unregisterPush() {
  let t = registered;
  try {
    t ||= localStorage.getItem("openlounge:pushToken");
  } catch {}
  if (!t) return;
  registered = null;
  await authFetch("/api/push/unregister", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: t }) }).catch(() => {});
}

export async function getNotifPrefs(): Promise<NotifPrefsClient> {
  const res = await authFetch("/api/notifications/prefs");
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "Couldn't load settings");
  return j.prefs;
}

export async function setNotifPrefs(patch: Partial<NotifPrefsClient>): Promise<NotifPrefsClient> {
  const res = await authFetch("/api/notifications/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "Couldn't save");
  return j.prefs;
}
