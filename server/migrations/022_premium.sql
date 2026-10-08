-- 022: Open Lounge Premium (flag PREMIUM_ENABLED, off by default). Additive, idempotent.
-- Sold on the web through the sticker PayPal pipeline (sticker_orders.pack_id = 'premium:month' | 'premium:year'),
-- or as an auto-renewing PayPal subscription when plan ids are configured.
-- Rows keep the full record in data JSONB; a few scalars are mirrored for reporting/indexes.

-- Premium-exclusive sticker packs (included with membership, never sold separately)
ALTER TABLE sticker_packs ADD COLUMN IF NOT EXISTS premium BOOLEAN NOT NULL DEFAULT FALSE;

-- One row per paid period: id = sticker order id | PayPal sale id | 'sub-first-<subscription id>' | 'admin-…'
CREATE TABLE IF NOT EXISTS premium_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ends_at BIGINT NOT NULL,
  data JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS premium_grants_user_idx ON premium_grants (user_id, ends_at DESC);

-- PayPal subscriptions (auto-renew); id = PayPal subscription id
CREATE TABLE IF NOT EXISTS premium_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS premium_subscriptions_user_idx ON premium_subscriptions (user_id);

-- Member settings: app icon, badge visibility; id = user id
CREATE TABLE IF NOT EXISTS premium_prefs (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);
