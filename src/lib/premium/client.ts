"use client";
// Client for Open Lounge Premium: config (public), my membership, prefs (app icon, badge), auto-renew,
// and a small batched badge cache used by <PremiumBadge>/<VerifiedBadge>.
import { useEffect, useSyncExternalStore } from "react";
import { getAccessToken } from "../auth";
import { inNativeShell } from "../authApi";
import { postToNative } from "./native";
import type { Badges, PremiumConfig, PremiumMe, PremiumPlan } from "./types";

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const t = await getAccessToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch {
    return {};
  }
}
export async function monetApi<T>(path: string, opts: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = opts.auth === false ? {} : await authHeaders();
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(path, { method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, cache: "no-store" });
  const j = (await r.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
  if (!r.ok || !j || j.ok === false) throw Object.assign(new Error(j?.error || "Something went wrong"), { status: r.status, data: j });
  return j;
}

export const premiumConfig = () => monetApi<{ config: PremiumConfig; wrapper: boolean }>("/api/premium/config", { auth: false });
export const premiumMe = () => monetApi<{ me: PremiumMe }>("/api/premium/me").then((r) => r.me);
export const savePrefs = (body: { appIcon?: string; badgeVisible?: boolean }) => monetApi<{ me: PremiumMe }>("/api/premium/prefs", { body }).then((r) => r.me);
export const subscribe = (plan: PremiumPlan) => monetApi<{ subscriptionId: string; approveUrl: string | null }>("/api/premium/subscribe", { body: { plan } });
export const syncSubscription = (subscriptionId: string) => monetApi<{ me: PremiumMe }>("/api/premium/subscription/sync", { body: { subscriptionId } }).then((r) => r.me);
export const cancelSubscription = () => monetApi<{ me: PremiumMe }>("/api/premium/cancel", { body: {} }).then((r) => r.me);
export const inApp = () => inNativeShell() || (typeof navigator !== "undefined" && /OpenLounge(\/(android|ios)\/|(Android|iOS))/i.test(navigator.userAgent));

// ---------- app icon ----------
const LS_ICON = "ol:premium:icon";
/** Web: swap the tab icon / home-screen icon. Native wrappers: ask the shell (see docs/native-app-icons.md). */
export function applyAppIcon(id: string) {
  if (typeof document === "undefined") return;
  try {
    localStorage.setItem(LS_ICON, id);
  } catch {}
  const classic = id === "classic";
  const set = (sel: string, rel: string, href: string, type?: string) => {
    let el = document.head.querySelector<HTMLLinkElement>(sel);
    if (!el) {
      el = document.createElement("link");
      el.rel = rel;
      document.head.appendChild(el);
    }
    el.dataset.premiumIcon = id;
    if (type) el.type = type;
    el.href = href;
  };
  if (classic) {
    document.head.querySelectorAll<HTMLLinkElement>("link[data-premium-icon]").forEach((l) => l.remove());
  } else {
    set('link[rel="icon"][data-premium-icon], link[rel="icon"][type="image/svg+xml"]', "icon", `/app-icons/${id}.svg`, "image/svg+xml");
    set('link[rel="apple-touch-icon"]', "apple-touch-icon", `/app-icons/${id}-180.png`);
  }
  if (inNativeShell()) postToNative({ type: "setAppIcon", name: classic ? null : id });
}
/** restore the saved web icon on boot (only meaningful while Premium is active; the server rejects otherwise) */
export function savedAppIcon() {
  try {
    return localStorage.getItem(LS_ICON) || "classic";
  } catch {
    return "classic";
  }
}

// ---------- badges (batched, cached 60s) ----------
const cache = new Map<string, { b: Badges; at: number }>();
const listeners = new Set<() => void>();
let pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let version = 0;
function flush() {
  timer = null;
  const ids = [...pending];
  pending = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    fetch(`/api/badges?ids=${chunk.map(encodeURIComponent).join(",")}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { badges?: Record<string, Badges> } | null) => {
        const now = Date.now();
        for (const id of chunk) cache.set(id, { b: j?.badges?.[id] ?? {}, at: now });
        version++;
        listeners.forEach((l) => l());
      })
      .catch(() => {});
  }
}
export function requestBadges(id: string) {
  const c = cache.get(id);
  if (c && Date.now() - c.at < 60_000) return;
  pending.add(id);
  if (!timer) timer = setTimeout(flush, 30);
}
export function useBadges(id: string | null | undefined): Badges {
  useEffect(() => {
    if (id) requestBadges(id);
  }, [id]);
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => version,
    () => 0,
  );
  return (id && cache.get(id)?.b) || {};
}
export function invalidateBadge(id: string) {
  cache.delete(id);
  requestBadges(id);
}
