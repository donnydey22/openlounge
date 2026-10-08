-- 027: sponsored rooms + highlighted ads (flag ADS_ENABLED, off by default). Additive, idempotent.
-- Campaigns are booked, scheduled and reviewed in /admin/ads (the same admin hub as in-chat sponsored messages, 021).
-- Reporting is aggregate only: one counter row per day × campaign × placement. Nothing per person is stored.
CREATE TABLE IF NOT EXISTS ad_campaigns (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,           -- draft | pending_review | approved | rejected | paused
  data JSONB NOT NULL,            -- full campaign (advertiser, booking, schedule, creative, review)
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ad_campaigns_status_idx ON ad_campaigns (status);

CREATE TABLE IF NOT EXISTS ad_stats_daily (
  day TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
  campaign_id TEXT NOT NULL,
  placement TEXT NOT NULL,        -- hallway | explore
  impressions BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  joins BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, campaign_id, placement)
);
