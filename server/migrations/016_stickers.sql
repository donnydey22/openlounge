-- 013: Telegram-style sticker library + PayPal purchases. Additive and idempotent.
-- Built-in free packs (Noto Animated Emoji) ship as files + server/stickers/noto-packs.json; this table only holds
-- packs created with the admin tool (/admin/stickers).
CREATE TABLE IF NOT EXISTS sticker_packs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Other',
  description TEXT NOT NULL DEFAULT '',
  -- NULL/0 = free (the default). Paid packs use a tier: 99 / 199 / 299 (USD cents).
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents IN (0, 99, 199, 299)),
  currency TEXT NOT NULL DEFAULT 'USD',
  published BOOLEAN NOT NULL DEFAULT FALSE,
  cover TEXT,
  attribution JSONB,
  stickers JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

-- "My stickers": packs a user added, in panel order
CREATE TABLE IF NOT EXISTS sticker_user_packs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  added_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, pack_id)
);

CREATE TABLE IF NOT EXISTS sticker_favorites (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id TEXT NOT NULL,
  sticker_id TEXT NOT NULL,
  added_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, pack_id, sticker_id)
);

CREATE TABLE IF NOT EXISTS sticker_recents (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id TEXT NOT NULL,
  sticker_id TEXT NOT NULL,
  used_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, pack_id, sticker_id)
);
CREATE INDEX IF NOT EXISTS sticker_recents_user_idx ON sticker_recents (user_id, used_at DESC);

-- PayPal Orders v2. Kept after account deletion (financial record; no FK to users).
CREATE TABLE IF NOT EXISTS sticker_orders (
  id TEXT PRIMARY KEY,                 -- PayPal order id
  user_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,                -- created | captured | refunded | reversed | failed
  capture_id TEXT,
  funding_source TEXT,                 -- paypal | apple_pay | google_pay | card
  payer_email TEXT,
  mode TEXT NOT NULL DEFAULT 'sandbox',
  created_at BIGINT NOT NULL,
  captured_at BIGINT,
  refunded_at BIGINT,
  receipt_sent_at BIGINT
);
CREATE INDEX IF NOT EXISTS sticker_orders_user_idx ON sticker_orders (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS sticker_orders_capture_idx ON sticker_orders (capture_id) WHERE capture_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sticker_entitlements (
  user_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  granted_at BIGINT NOT NULL,
  revoked_at BIGINT,
  PRIMARY KEY (user_id, pack_id)
);

-- webhook idempotency (PayPal retries deliveries)
CREATE TABLE IF NOT EXISTS paypal_webhook_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  resource_id TEXT,
  received_at BIGINT NOT NULL
);
