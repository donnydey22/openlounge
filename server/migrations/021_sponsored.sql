-- 021: sponsored messages (Telegram-style), admin-managed. Additive + idempotent. OFF by default: the master switch
-- row is created 'off' and every new ad starts disabled, so nothing is ever shown until an admin turns both on.
-- No tracking: no impression/click logging, no third-party SDKs; only per-user "hide" and reports are stored.
CREATE TABLE IF NOT EXISTS sponsored_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO sponsored_settings (key, value) VALUES ('enabled', 'off') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS sponsored_messages (
  id             TEXT PRIMARY KEY,
  advertiser     TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  body           TEXT    NOT NULL DEFAULT '',
  cta_label      TEXT    NOT NULL DEFAULT 'Learn more',
  cta_url        TEXT    NOT NULL,
  placements     TEXT[]  NOT NULL DEFAULT '{rooms}',   -- 'rooms' (bottom of the room list), 'groups' (large groups)
  min_group_size INTEGER NOT NULL DEFAULT 100,
  starts_at      BIGINT  NOT NULL,
  ends_at        BIGINT,
  enabled        BOOLEAN NOT NULL DEFAULT FALSE,
  avatar_jpeg    BYTEA,                                -- re-encoded server-side (sharp), ≤ 256 px
  image_jpeg     BYTEA,                                -- re-encoded server-side (sharp), ≤ 1080 px
  image_w        INTEGER,
  image_h        INTEGER,
  version        BIGINT  NOT NULL DEFAULT 1,
  created_by     TEXT    NOT NULL,
  created_at     BIGINT  NOT NULL,
  updated_at     BIGINT  NOT NULL
);
CREATE INDEX IF NOT EXISTS sponsored_messages_active_idx ON sponsored_messages (starts_at DESC) WHERE enabled;

CREATE TABLE IF NOT EXISTS sponsored_hides (
  user_id      TEXT   NOT NULL,
  sponsored_id TEXT   NOT NULL,
  created_at   BIGINT NOT NULL,
  PRIMARY KEY (user_id, sponsored_id)
);

CREATE TABLE IF NOT EXISTS sponsored_reports (
  id           BIGSERIAL PRIMARY KEY,
  user_id      TEXT   NOT NULL,
  sponsored_id TEXT   NOT NULL,
  reason       TEXT   NOT NULL,
  created_at   BIGINT NOT NULL,
  UNIQUE (user_id, sponsored_id)
);
