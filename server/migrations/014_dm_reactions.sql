-- 014: Telegram-style emoji reactions on DMs. One row per (message, person, emoji); the app allows one reaction per
-- person per message (picking another replaces it) but the key doesn't force that, so a future "up to 3" is a
-- code-only change. Rows go with their message (per-conversation history cap, account deletion). Idempotent.
-- (012 is reserved by the username-signin branch, 013 by the room-invites work.)

CREATE TABLE IF NOT EXISTS dm_reactions (
  message_id TEXT   NOT NULL REFERENCES dms(id) ON DELETE CASCADE,
  user_id    TEXT   NOT NULL,
  emoji      TEXT   NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 32),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS dm_reactions_user_idx ON dm_reactions (user_id);
