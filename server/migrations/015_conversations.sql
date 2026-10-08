-- 015: generic conversations (Telegram-style groups). Additive + idempotent.
-- Messages stay in `dms` (conversation_id = "<a>|<b>" for 1:1, "g_…" for groups; to_id = the group id), so reactions,
-- expiring files, stickers, invite cards and moderation keep working on group messages without schema changes.
-- Existing 1:1 conversations are backfilled as type 'dm' with their two members (no data is moved or dropped).

CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('dm', 'group')),
  title        TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL DEFAULT '#10B981',
  photo_version BIGINT,
  created_by   TEXT,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  member_limit INTEGER NOT NULL DEFAULT 200,
  deleted_at   BIGINT
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at    BIGINT NOT NULL,
  muted        BOOLEAN NOT NULL DEFAULT FALSE,
  last_read_at BIGINT NOT NULL DEFAULT 0,
  added_by     TEXT,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS conversation_members_user_idx ON conversation_members (user_id);

-- group photo bytes (client-resized, ≤ 400 KB) — kept in Postgres so they survive redeploys without a volume
CREATE TABLE IF NOT EXISTS conversation_photos (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  mime    TEXT NOT NULL,
  bytes   BYTEA NOT NULL,
  version BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_pins (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  pinned_by  TEXT,
  pinned_at  BIGINT NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);

CREATE TABLE IF NOT EXISTS conversation_invites (
  token        TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_by   TEXT,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT,
  max_uses     INTEGER,
  uses         INTEGER NOT NULL DEFAULT 0,
  revoked_at   BIGINT
);
CREATE INDEX IF NOT EXISTS conversation_invites_conv_idx ON conversation_invites (conversation_id);

-- "Maya added Ryan" style service messages: the dms row holds the readable text, this holds the structured event
CREATE TABLE IF NOT EXISTS conversation_service (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  payload    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_service_conv_idx ON conversation_service (conversation_id);

-- reports can target a whole group
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_reports_target_type_check') THEN
    ALTER TABLE content_reports DROP CONSTRAINT content_reports_target_type_check;
  END IF;
  ALTER TABLE content_reports ADD CONSTRAINT content_reports_target_type_check CHECK (target_type IN ('user', 'room', 'message', 'dm', 'group'));
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- backfill: every existing 1:1 conversation becomes a 'dm' conversation with its two members
INSERT INTO conversations (id, type, created_at, updated_at)
SELECT conversation_id, 'dm', MIN(created_at), MAX(created_at)
FROM dms WHERE conversation_id LIKE '%|%'
GROUP BY conversation_id
ON CONFLICT (id) DO NOTHING;

INSERT INTO conversation_members (conversation_id, user_id, role, joined_at, last_read_at)
SELECT c.id, m.uid, 'member', c.created_at, COALESCE(r.last_read_at, 0)
FROM conversations c
CROSS JOIN LATERAL (VALUES (split_part(c.id, '|', 1), split_part(c.id, '|', 2))) AS p(a, b)
CROSS JOIN LATERAL (VALUES (p.a, p.b), (p.b, p.a)) AS m(uid, peer)
LEFT JOIN dm_reads r ON r.user_id = m.uid AND r.peer_id = m.peer
WHERE c.type = 'dm'
ON CONFLICT (conversation_id, user_id) DO NOTHING;
