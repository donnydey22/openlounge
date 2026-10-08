// Business & creator accounts (flag CREATOR_ENABLED, off by default). Shared server/client types.
export type AccountType = "creator" | "business";
export type VerifyStatus = "awaiting_payment" | "pending" | "approved" | "rejected" | "revoked";

export interface CreatorProfile {
  id: string; // userId
  type: AccountType;
  enabled: boolean;
  createdAt: number;
}

export interface VerificationRequest {
  id: string;
  userId: string;
  kind: AccountType;
  legalName: string;
  businessName: string;
  website: string;
  country: string;
  /** private files on the volume (admin-only, deleted once decided) */
  docs: { id: string; label: string; mime: string }[];
  status: VerifyStatus;
  feeCents: number;
  orderId: string | null;
  note: string;
  reviewedBy: string | null;
  reviewedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Branding {
  id: string; // host userId
  slug: string; // openlounge.app/r/<slug>
  displayName: string;
  logo: string | null; // /creator-files/<file>
  cover: string | null;
  accent: string; // #RRGGBB
  background: string; // #RRGGBB
  coHosts: string[]; // user ids allowed to co-host this host's rooms
  updatedAt: number;
}

export interface Series {
  id: string;
  hostId: string;
  title: string;
  description: string;
  /** 0=Sun … 6=Sat */
  weekdays: number[];
  time: string; // "HH:MM" in tz
  tz: string; // IANA zone
  durationMin: number;
  active: boolean;
  createdAt: number;
}

export interface RoomSession {
  id: string; // room id
  hostId: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  peak: number;
  uniqueListeners: number;
  listenerMinutes: number;
  /** concurrency sampled about once a minute: [minutesSinceStart, listeners] (downsampled to ≤240 points) */
  curve: [number, number][];
  /** share of unique listeners still there at 5/15/30/60 min after they joined */
  retention: { m5: number; m15: number; m30: number; m60: number };
  replays: number;
}

export interface CreatorAnalytics {
  sessions: RoomSession[];
  totals: { rooms: number; listeners: number; peak: number; listenerMinutes: number; avgListenMin: number; replays: number };
  followers: { day: string; followers: number }[];
}

export interface CreatorConfig {
  enabled: boolean;
  checkout: boolean;
  fees: Record<AccountType, number>;
  feeWaived: boolean;
  replays: boolean;
}
