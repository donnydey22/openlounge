-- 028: business & creator accounts (flag CREATOR_ENABLED, off by default). Additive, idempotent.
-- Each row keeps the full record in data JSONB; a few scalars are mirrored for reporting/indexes.
-- ID documents are NOT stored here (private files on the volume, deleted once a request is decided).
CREATE TABLE IF NOT EXISTS creator_profiles (
  id TEXT PRIMARY KEY,            -- user id
  data JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,           -- awaiting_payment | pending | approved | rejected | revoked
  data JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS verification_requests_user_idx ON verification_requests (user_id);
CREATE INDEX IF NOT EXISTS verification_requests_status_idx ON verification_requests (status);
CREATE TABLE IF NOT EXISTS user_badges (
  id TEXT PRIMARY KEY,            -- user id
  data JSONB NOT NULL,            -- { verified: creator|business, since, requestId }
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_branding (
  id TEXT PRIMARY KEY,            -- host user id
  slug TEXT,                      -- openlounge.app/r/<slug>
  data JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS room_branding_slug_idx ON room_branding (slug) WHERE slug IS NOT NULL AND slug <> '';
CREATE TABLE IF NOT EXISTS room_series (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS room_series_host_idx ON room_series (host_id);
CREATE TABLE IF NOT EXISTS creator_room_sessions (
  id TEXT PRIMARY KEY,            -- room id
  host_id TEXT NOT NULL,
  data JSONB NOT NULL,            -- aggregate only: peak, unique listeners, listener-minutes, curve, retention, replays
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS creator_room_sessions_host_idx ON creator_room_sessions (host_id);
CREATE TABLE IF NOT EXISTS creator_follower_daily (
  id TEXT PRIMARY KEY,            -- "<user id>|<YYYY-MM-DD>"
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS creator_follower_daily_user_idx ON creator_follower_daily (user_id, day);
