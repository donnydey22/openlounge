// Sticker catalog types shared by the server (server/stickers) and the web client.

export type StickerFormat = "lottie" | "webp" | "png";

export interface Sticker {
  id: string;
  emoji: string;
  keywords: string[];
  format: StickerFormat;
  /** path under /sticker-files/ (Lottie .json.gz, or an image) */
  file: string;
  /** static poster under /sticker-files/ (first frame) — instant paint, reduced motion, low-end devices */
  poster: string;
  w?: number;
  h?: number;
  bytes?: number;
}

export interface Attribution {
  text: string;
  author: string;
  source: string;
  license: string;
  licenseUrl: string;
}

export interface StickerPack {
  id: string;
  title: string;
  emoji: string;
  category: string;
  description: string;
  /** null or 0 = free. Paid packs use a price tier (USD cents). */
  priceCents: number | null;
  currency: string;
  published: boolean;
  builtin?: boolean;
  /** Open Lounge Premium exclusive: members get it free, nobody can buy it separately */
  premium?: boolean;
  cover: string;
  attribution: Attribution | null;
  stickers: Sticker[];
}

export type PackSummary = Omit<StickerPack, "stickers"> & { count: number; preview: Sticker[] };

/** Mirror Telegram: almost everything free, a few paid packs at small fixed tiers. */
export const PRICE_TIERS = [99, 199, 299] as const;
export const isFree = (p: { priceCents: number | null; premium?: boolean }) => !p.premium && !p.priceCents;
export const formatPrice = (cents: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);

export interface StickerConfig {
  /** paid checkout switched on server-side (STICKERS_PAID_ENABLED=1 and PayPal configured) */
  paidEnabled: boolean;
  mode: "sandbox" | "live";
  paypalClientId: string | null;
  applePay: boolean;
  googlePay: boolean;
  /** Google Pay & Wallet Console merchant id (required for PRODUCTION; unused in TEST) */
  googleMerchantId?: string | null;
  currency: string;
  tiers: readonly number[];
}

export interface MyStickers {
  added: string[];
  favorites: { packId: string; stickerId: string }[];
  recents: { packId: string; stickerId: string }[];
  owned: string[];
}

export interface Receipt {
  orderId: string;
  packId: string;
  packTitle: string;
  amountCents: number;
  currency: string;
  status: "created" | "captured" | "refunded" | "reversed" | "failed";
  fundingSource: string | null;
  createdAt: number;
  capturedAt: number | null;
  refundedAt: number | null;
  mode: "sandbox" | "live";
}
