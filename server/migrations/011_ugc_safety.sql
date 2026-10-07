-- 011: UGC safety (App Store guideline 1.2) — user blocks + content reports. Idempotent.
-- (010 is reserved by the email-otp branch.)

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS user_blocks_blocked_idx ON user_blocks (blocked_id);

CREATE TABLE IF NOT EXISTS content_reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('user', 'room', 'message', 'dm')),
  target_id TEXT NOT NULL,
  target_user_id TEXT,
  room_id TEXT,
  reason TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS content_reports_created_idx ON content_reports (created_at DESC);
CREATE INDEX IF NOT EXISTS content_reports_target_user_idx ON content_reports (target_user_id);
