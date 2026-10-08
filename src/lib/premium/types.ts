// Open Lounge Premium: shared types + perk catalogue (server and client).
export type PremiumPlan = "month" | "year";

export interface Limits {
  /** max upload size (MB) for files/media in chat */
  uploadMaxMB: number;
  /** allowed expiring-file lifetimes (days) */
  fileExpiryDays: number[];
}
export const FREE_LIMITS: Limits = { uploadMaxMB: 25, fileExpiryDays: [1, 7] };
export const PREMIUM_LIMITS: Limits = { uploadMaxMB: 200, fileExpiryDays: [1, 7, 30, 90] };

export interface AppIcon {
  id: string;
  name: string;
  premium: boolean;
}
export const APP_ICONS: AppIcon[] = [
  { id: "classic", name: "Classic", premium: false },
  { id: "midnight", name: "Midnight", premium: true },
  { id: "sunset", name: "Sunset", premium: true },
  { id: "ocean", name: "Ocean", premium: true },
  { id: "gold", name: "Gold", premium: true },
  { id: "mono", name: "Mono", premium: true },
];

export interface EarlyFeature {
  id: string;
  name: string;
  description: string;
}

export interface PremiumConfig {
  enabled: boolean;
  /** web checkout available (Premium on + paid checkout on + PayPal configured) */
  checkout: boolean;
  /** auto-renewing PayPal subscription available for these plans (plan ids configured) */
  subscriptions: PremiumPlan[];
  prices: Record<PremiumPlan, number>;
  currency: string;
  free: Limits;
  premium: Limits;
  icons: AppIcon[];
  early: EarlyFeature[];
  mode: "sandbox" | "live";
}

export interface PremiumMe {
  active: boolean;
  endsAt: number | null;
  plan: PremiumPlan | null;
  source: "order" | "subscription" | "grant" | null;
  autoRenew: boolean;
  subscriptionId: string | null;
  prefs: PremiumPrefs;
  limits: Limits;
}
export interface PremiumPrefs {
  appIcon: string;
  badgeVisible: boolean;
}

export interface Badges {
  premium?: true;
  verified?: "creator" | "business";
}
