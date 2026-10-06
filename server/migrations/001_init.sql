-- Open Lounge (formerly Clubroom) durable storage (everything that used to live in DATA_DIR/db.json).
-- Applied automatically at boot by server/pg.ts; safe to re-run (IF NOT EXISTS everywhere).
-- Timestamps are epoch milliseconds (BIGINT) to round-trip the app's Date.now() values exactly.
-- Memory-only state (presence, hands, mute, podium, speaking, in-room chat, reactions) is NOT stored here.
-- Demo bots (ids "bot-*") are re-seeded in memory on every boot and are never stored in `users`.

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,                -- "u_<uuid>"
  name            TEXT    NOT NULL,
  username        TEXT    NOT NULL,
  color           TEXT    NOT NULL,
  bio             TEXT    NOT NULL DEFAULT '',
  phone           TEXT,                            -- E.164, never sent to other users
  created_at      BIGINT  NOT NULL,
  base_followers  INTEGER NOT NULL DEFAULT 0,
  base_following  INTEGER NOT NULL DEFAULT 0,
  photo_version   BIGINT,                          -- NULL = no uploaded photo (file lives in DATA_DIR/avatars)
  -- deferred so a username swap inside one save transaction can't trip the check mid-way
  CONSTRAINT users_username_key UNIQUE (username) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT users_phone_key    UNIQUE (phone)    DEFERRABLE INITIALLY DEFERRED
);

-- Ordered interest chips picked at sign-up / edited in Settings (max 12 per user, enforced by the app)
CREATE TABLE IF NOT EXISTS user_interests (
  user_id   TEXT     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position  SMALLINT NOT NULL,
  interest  TEXT     NOT NULL,
  PRIMARY KEY (user_id, position)
);
CREATE INDEX IF NOT EXISTS user_interests_interest_idx ON user_interests (interest);

-- follower -> followee. Followee may be a demo bot, so it has no FK.
CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS follows_followee_idx ON follows (followee_id);

-- Metadata of user-created rooms that are still open (seeded demo rooms are never stored).
-- Rows are removed when the room ends, exactly like db.json did.
CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  title       TEXT   NOT NULL,
  topic       TEXT   NOT NULL,
  description TEXT   NOT NULL DEFAULT '',
  host_id     TEXT   NOT NULL,
  created_at  BIGINT NOT NULL
);

-- 1:1 direct messages (app keeps the newest 1000 per conversation; trimmed rows are deleted)
CREATE TABLE IF NOT EXISTS dms (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT   NOT NULL,                 -- "<smaller id>|<larger id>"
  from_id         TEXT   NOT NULL,
  from_name       TEXT   NOT NULL,
  from_color      TEXT   NOT NULL,
  to_id           TEXT   NOT NULL,
  text            TEXT   NOT NULL,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS dms_conversation_idx ON dms (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS dms_to_idx ON dms (to_id, created_at);

-- Sign-in sessions: only the SHA-256 of the token is stored. 60-day sliding expiry.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- DM read cursors: user has read everything from peer up to last_read_at
CREATE TABLE IF NOT EXISTS dm_reads (
  user_id      TEXT   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id      TEXT   NOT NULL,
  last_read_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, peer_id)
);

-- Small key/value table (e.g. "json_imported" marker for the one-time db.json import).
-- Renamed to openlounge_meta by 002_rename_meta.sql (applied migrations are never edited).
CREATE TABLE IF NOT EXISTS clubroom_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
