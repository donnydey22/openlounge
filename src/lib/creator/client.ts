"use client";
// Client for business & creator accounts (flag CREATOR_ENABLED). Uses the shared monetization fetch helper.
import { monetApi } from "../premium/client";
import type { Branding, CreatorAnalytics, CreatorConfig, CreatorProfile, Series, VerificationRequest } from "./types";

export interface CreatorMe {
  profile: CreatorProfile | null;
  verified: "creator" | "business" | null;
  request: VerificationRequest | null;
  branding: Branding | null;
  series: Series[];
  config: CreatorConfig;
}
export interface BrandPage {
  branding: Branding;
  host: { id: string; name: string; username?: string; verified: "creator" | "business" | null };
  live: { id: string; title: string; listeners: number } | null;
  upcoming: { seriesId: string; title: string; at: number; durationMin: number }[];
}
export type RoomBrand = Branding & { verified: "creator" | "business" | null };

export const creatorConfig = () => monetApi<{ config: CreatorConfig; wrapper: boolean }>("/api/creator/config", { auth: false });
export const creatorMe = () => monetApi<CreatorMe & { ok: true }>("/api/creator/me");
export const setCreatorProfile = (body: { type?: "creator" | "business"; enabled?: boolean }) => monetApi<{ profile: CreatorProfile }>("/api/creator/profile", { body });
export const applyVerification = (body: Record<string, unknown>) => monetApi<{ request: VerificationRequest; checkoutRef: string | null }>("/api/creator/verify", { body });
export const withdrawVerification = () => monetApi<{ ok: true }>("/api/creator/verify/withdraw", { body: {} });
export const creatorAnalytics = (days: number) => monetApi<{ analytics: CreatorAnalytics }>(`/api/creator/analytics?days=${days}`).then((r) => r.analytics);
export const saveBranding = (body: Record<string, unknown>) => monetApi<{ branding: Branding }>("/api/creator/branding", { body }).then((r) => r.branding);
export const saveSeries = (body: Partial<Series>) => monetApi<{ series: Series }>("/api/creator/series", { body }).then((r) => r.series);
export const deleteSeries = (id: string) => monetApi<{ ok: true }>("/api/creator/series/delete", { body: { id } });
export const brandPage = (slug: string) => monetApi<BrandPage & { ok: true }>(`/api/r/${encodeURIComponent(slug)}`, { auth: false });

const roomBrandCache = new Map<string, Promise<RoomBrand | null>>();
export function roomBranding(hostId: string) {
  let p = roomBrandCache.get(hostId);
  if (!p) {
    p = monetApi<{ branding: RoomBrand | null }>(`/api/rooms/branding/${encodeURIComponent(hostId)}`, { auth: false })
      .then((r) => r.branding)
      .catch(() => null);
    roomBrandCache.set(hostId, p);
  }
  return p;
}

export function readFileAsDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
