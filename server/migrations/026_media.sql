-- 026: photos, videos, documents and voice notes in chats (+ Telegram-style self-destructing media). Additive, idempotent.
-- Files live on the app volume at UPLOAD_DIR; this table holds their metadata. The DM row keeps a plain-text label
-- ("📷 Photo") or the caption in dms.text, so inbox previews, pushes and older clients keep working.
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  -- set when sent: conversation (DMs: "<a>|<b>", groups: their conversation id) + the message carrying it
  conversation_id TEXT,
  message_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('photo', 'video', 'document', 'voice')),
  mime TEXT NOT NULL,
  name TEXT,
  size_bytes BIGINT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  waveform TEXT,
  placeholder TEXT,
  gif BOOLEAN NOT NULL DEFAULT FALSE,
  -- variant -> { "file": "full.jpg", "mime": "image/jpeg", "size": 123 }
  files JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('processing', 'ready', 'failed')),
  label BOOLEAN NOT NULL DEFAULT TRUE,
  ttl_seconds INTEGER,
  view_once BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at BIGINT,
  opened_at BIGINT,
  played_at BIGINT,
  created_at BIGINT NOT NULL,
  sent_at BIGINT,
  -- albums: several rows share one message_id, ordered by position (0 = cover)
  position SMALLINT NOT NULL DEFAULT 0
);
ALTER TABLE media ADD COLUMN IF NOT EXISTS position SMALLINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS media_message_idx ON media (message_id);
CREATE INDEX IF NOT EXISTS media_owner_idx ON media (owner_id);
CREATE INDEX IF NOT EXISTS media_expires_idx ON media (expires_at) WHERE expires_at IS NOT NULL;

-- What's left after a self-destruct / view-once / "Delete now": only the kind, so the chat shows "Photo expired"
-- and replies to it still make sense. The file and its media row are gone.
CREATE TABLE IF NOT EXISTS media_tombstones (
  message_id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  conversation_id TEXT,
  kind TEXT NOT NULL,
  gif BOOLEAN NOT NULL DEFAULT FALSE,
  view_once BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT NOT NULL CHECK (reason IN ('expired', 'viewed', 'deleted')),
  at BIGINT NOT NULL
);
