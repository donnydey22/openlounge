-- 012 (store compliance): moderator enforcement for UGC reports (App Store 1.2 "timely responses",
-- Play UGC policy). Additive and idempotent. Named 012_store_moderation so it never collides with another 012_*.
--   user_suspensions    a suspended account can't use the service (every token is rejected) until unsuspended
--   moderation_actions  audit log of what a moderator did and why (kept after the target is gone)

CREATE TABLE IF NOT EXISTS user_suspensions (
  user_id    TEXT PRIMARY KEY,
  reason     TEXT NOT NULL DEFAULT '',
  by_id      TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id         TEXT PRIMARY KEY,
  report_id  TEXT,
  action     TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  by_id      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS moderation_actions_created_idx ON moderation_actions (created_at DESC);
