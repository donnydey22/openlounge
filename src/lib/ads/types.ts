// Sponsored rooms + highlighted ads (flag ADS_ENABLED, off by default). Shared by server and client.
export type AdPlacement = "hallway" | "explore";
export const AD_PLACEMENTS: AdPlacement[] = ["hallway", "explore"];
export type CampaignStatus = "draft" | "pending_review" | "approved" | "rejected" | "paused";
/** room = promote a host's live room ("Sponsored" room card, falls back to the ad card while they're offline); card = highlighted ad */
export type CampaignKind = "room" | "card";

export interface Campaign {
  id: string;
  advertiser: string;
  /** advertiser contact (admin only; never sent to viewers) */
  contact: string;
  kind: CampaignKind;
  placements: AdPlacement[];
  /** room campaigns: whose live room to feature (any room they host) */
  hostId: string | null;
  title: string;
  body: string;
  image: string | null; // /ad-files/<file>.jpg
  ctaLabel: string;
  ctaUrl: string;
  startsAt: number;
  endsAt: number | null;
  /** max times one person sees it per day (memory only, nothing stored per person) */
  capPerDay: number;
  weight: number;
  status: CampaignStatus;
  review: { by: string; at: number; note: string } | null;
  booking: { priceCents: number | null; reference: string; notes: string };
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** what a viewer gets: no contact, booking or review details */
export interface AdView {
  id: string;
  placement: AdPlacement;
  advertiser: string;
  kind: CampaignKind;
  title: string;
  body: string;
  image: string | null;
  ctaLabel: string;
  ctaUrl: string;
  room: { id: string; title: string; hostName: string; speakerCount: number; listenerCount: number; speakers: { id: string; name: string; color: string; photoUrl: string | null }[] } | null;
}

export interface AdStatsRow {
  day: string; // YYYY-MM-DD (UTC)
  campaignId: string;
  placement: AdPlacement;
  impressions: number;
  clicks: number;
  joins: number;
}
