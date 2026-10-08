-- 012 (store compliance): Telegram-style account deletion. A deleted member's users row stays as a scrubbed
-- tombstone (no phone, password, bio, photo, links; name "Deleted Account"; placeholder username) so messages they
-- sent still render in other people's chats. Additive and idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at BIGINT;
CREATE INDEX IF NOT EXISTS users_deleted_idx ON users (deleted_at) WHERE deleted_at IS NOT NULL;
