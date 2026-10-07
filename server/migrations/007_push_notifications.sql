-- Push notifications (FCM), per-user notification settings, opt-in contact matching.
-- Idempotent. Numbered 007 (006 is reserved by the social-links branch). No FKs to users: users are flushed
-- by the batched snapshot writer, so a just-created account may not be in the table yet.

CREATE TABLE IF NOT EXISTS device_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  platform   TEXT NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_tokens_user_idx ON device_tokens (user_id);

-- prefs: { dm, roomInvite, followedRoom, trendingRoom, scheduledRoom, recentRoom, newFollower, contactJoined,
--          quietHours: { start: "22:00", end: "08:00", tz: "America/Phoenix" } | null }  (missing keys = defaults)
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id    TEXT PRIMARY KEY,
  prefs      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Contact matching: clients send SHA-256(E.164); we store HMAC-SHA256(CONTACTS_PEPPER, that hash) only.
CREATE TABLE IF NOT EXISTS contact_hashes (
  owner_id   TEXT NOT NULL,
  hash       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, hash)
);
CREATE INDEX IF NOT EXISTS contact_hashes_hash_idx ON contact_hashes (hash);
