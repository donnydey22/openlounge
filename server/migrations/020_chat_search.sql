-- 020: chat search index: #hashtags, @mentions, full-text + trigram (additive + idempotent; no existing data is modified).
-- Join tables are maintained by triggers on dms / rooms / users, so every write path (live send, edits, moderator
-- removals, the per-conversation trim, account deletion) keeps the index in sync without app changes, and the
-- existing rows are backfilled once below. Tags are stored lowercase. The search endpoint re-checks every hit with
-- the app tokenizer (src/lib/linkify.ts) and scopes results to the caller's memberships, so the SQL extractor
-- only has to be a close superset. Trigger bodies swallow their own errors: indexing can never block a write.

-- same definition as 012_store_users_deleted_at (account deletion); repeated so this file never depends on its order
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at BIGINT;

CREATE TABLE IF NOT EXISTS hashtags (
  tag        TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_hashtags (
  tag             TEXT   NOT NULL,
  message_id      TEXT   NOT NULL,
  conversation_id TEXT   NOT NULL,
  created_at      BIGINT NOT NULL,
  PRIMARY KEY (tag, message_id)
);
CREATE INDEX IF NOT EXISTS message_hashtags_conv_idx ON message_hashtags (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS message_hashtags_tag_time_idx ON message_hashtags (tag, created_at DESC);
CREATE INDEX IF NOT EXISTS message_hashtags_msg_idx ON message_hashtags (message_id);

CREATE TABLE IF NOT EXISTS room_hashtags (
  tag     TEXT NOT NULL,
  room_id TEXT NOT NULL,
  PRIMARY KEY (tag, room_id)
);
CREATE INDEX IF NOT EXISTS room_hashtags_room_idx ON room_hashtags (room_id);

CREATE TABLE IF NOT EXISTS user_hashtags (
  tag     TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (tag, user_id)
);
CREATE INDEX IF NOT EXISTS user_hashtags_user_idx ON user_hashtags (user_id);

-- @mentions in messages. handle = lowercase screen name as typed; user_id = who it resolved to at write time
-- (screen names can change later; the mention keeps pointing at the person it was sent to).
CREATE TABLE IF NOT EXISTS message_mentions (
  handle          TEXT   NOT NULL,
  message_id      TEXT   NOT NULL,
  user_id         TEXT,
  conversation_id TEXT   NOT NULL,
  created_at      BIGINT NOT NULL,
  PRIMARY KEY (handle, message_id)
);
CREATE INDEX IF NOT EXISTS message_mentions_user_idx ON message_mentions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS message_mentions_msg_idx ON message_mentions (message_id);
CREATE INDEX IF NOT EXISTS message_mentions_conv_idx ON message_mentions (conversation_id, created_at DESC);

-- full-text (language-neutral 'simple' config: no stemming, works for every script) for keyword search
CREATE INDEX IF NOT EXISTS dms_text_fts_idx ON dms USING gin (to_tsvector('simple', text));
-- trigram for partial words ("photo" finds "telephoto"); skipped (keyword search falls back to ILIKE) if the
-- extension can't be installed on this server
DO $do$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'pg_trgm unavailable: %', SQLERRM;
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS dms_text_trgm_idx ON dms USING gin (text gin_trgm_ops)';
  END IF;
END
$do$;

-- #tag extractor: drops `code spans`, URLs and e-mail addresses first; tag = letters/digits/_ with >= 1 letter, <= 64.
CREATE OR REPLACE FUNCTION ol_hashtags(t TEXT) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT COALESCE(array_agg(DISTINCT lower(m[1])) FILTER (WHERE m[1] ~ '[[:alpha:]]' AND char_length(m[1]) <= 64), '{}'::TEXT[])
  FROM regexp_matches(
    regexp_replace(
      regexp_replace(COALESCE(left(t, 20000), ''), '`[^`\n]*`', ' ', 'g'),
      '([a-z][a-z0-9+.-]*://|www\.)[^[:space:]]+|[^[:space:]]+@[^[:space:]]+|[^[:space:]#/]+\.[a-z]{2,}/[^[:space:]]*',
      ' ', 'gi'),
    '(?:^|[^[:alnum:]_&/#])#([[:alnum:]_]+)', 'g') AS m
$fn$;

-- @handle extractor (same rule as src/lib/linkify.ts / group mention notifications): 3-20 of [A-Za-z0-9_]
CREATE OR REPLACE FUNCTION ol_mentions(t TEXT) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT COALESCE(array_agg(DISTINCT lower(m[1])) FILTER (WHERE char_length(m[1]) BETWEEN 3 AND 20), '{}'::TEXT[])
  FROM regexp_matches(
    regexp_replace(
      regexp_replace(COALESCE(left(t, 20000), ''), '`[^`\n]*`', ' ', 'g'),
      '([a-z][a-z0-9+.-]*://|www\.)[^[:space:]]+|[^[:space:]]+@[^[:space:]]+\.[^[:space:]]+',
      ' ', 'gi'),
    '(?:^|[^[:alnum:]_@&/#.])@([A-Za-z0-9_]+)', 'g') AS m
$fn$;

CREATE OR REPLACE FUNCTION ol_dms_hashtags_trg() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  BEGIN
    IF TG_OP <> 'INSERT' THEN
      DELETE FROM message_hashtags WHERE message_id = OLD.id;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.kind IS NULL AND strpos(NEW.text, '#') > 0 THEN
      INSERT INTO hashtags (tag, created_at) SELECT x, NEW.created_at FROM unnest(ol_hashtags(NEW.text)) AS x ON CONFLICT DO NOTHING;
      INSERT INTO message_hashtags (tag, message_id, conversation_id, created_at)
        SELECT x, NEW.id, NEW.conversation_id, NEW.created_at FROM unnest(ol_hashtags(NEW.text)) AS x ON CONFLICT DO NOTHING;
    END IF;
    IF TG_OP <> 'INSERT' THEN
      DELETE FROM message_mentions WHERE message_id = OLD.id;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.kind IS NULL AND strpos(NEW.text, '@') > 0 THEN
      INSERT INTO message_mentions (handle, message_id, user_id, conversation_id, created_at)
        SELECT x, NEW.id, (SELECT u.id FROM users u WHERE u.username = x LIMIT 1), NEW.conversation_id, NEW.created_at
        FROM unnest(ol_mentions(NEW.text)) AS x ON CONFLICT DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'hashtag index (dms): %', SQLERRM;
  END;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION ol_rooms_hashtags_trg() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  BEGIN
    IF TG_OP <> 'INSERT' THEN
      DELETE FROM room_hashtags WHERE room_id = OLD.id;
    END IF;
    IF TG_OP <> 'DELETE' AND strpos(NEW.title || ' ' || NEW.description, '#') > 0 THEN
      INSERT INTO hashtags (tag, created_at) SELECT x, NEW.created_at FROM unnest(ol_hashtags(NEW.title || E'\n' || NEW.description)) AS x ON CONFLICT DO NOTHING;
      INSERT INTO room_hashtags (tag, room_id) SELECT x, NEW.id FROM unnest(ol_hashtags(NEW.title || E'\n' || NEW.description)) AS x ON CONFLICT DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'hashtag index (rooms): %', SQLERRM;
  END;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION ol_users_hashtags_trg() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  BEGIN
    IF TG_OP <> 'INSERT' THEN
      DELETE FROM user_hashtags WHERE user_id = OLD.id;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.deleted_at IS NULL AND strpos(NEW.bio, '#') > 0 THEN
      INSERT INTO hashtags (tag, created_at) SELECT x, NEW.created_at FROM unnest(ol_hashtags(NEW.bio)) AS x ON CONFLICT DO NOTHING;
      INSERT INTO user_hashtags (tag, user_id) SELECT x, NEW.id FROM unnest(ol_hashtags(NEW.bio)) AS x ON CONFLICT DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'hashtag index (users): %', SQLERRM;
  END;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS dms_hashtags_ins ON dms;
CREATE TRIGGER dms_hashtags_ins AFTER INSERT OR DELETE ON dms FOR EACH ROW EXECUTE FUNCTION ol_dms_hashtags_trg();
DROP TRIGGER IF EXISTS dms_hashtags_upd ON dms;
CREATE TRIGGER dms_hashtags_upd AFTER UPDATE OF text, kind ON dms FOR EACH ROW
  WHEN (OLD.text IS DISTINCT FROM NEW.text OR OLD.kind IS DISTINCT FROM NEW.kind) EXECUTE FUNCTION ol_dms_hashtags_trg();

DROP TRIGGER IF EXISTS rooms_hashtags_ins ON rooms;
CREATE TRIGGER rooms_hashtags_ins AFTER INSERT OR DELETE ON rooms FOR EACH ROW EXECUTE FUNCTION ol_rooms_hashtags_trg();
DROP TRIGGER IF EXISTS rooms_hashtags_upd ON rooms;
CREATE TRIGGER rooms_hashtags_upd AFTER UPDATE OF title, description ON rooms FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title OR OLD.description IS DISTINCT FROM NEW.description) EXECUTE FUNCTION ol_rooms_hashtags_trg();

DROP TRIGGER IF EXISTS users_hashtags_ins ON users;
CREATE TRIGGER users_hashtags_ins AFTER INSERT OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION ol_users_hashtags_trg();
DROP TRIGGER IF EXISTS users_hashtags_upd ON users;
CREATE TRIGGER users_hashtags_upd AFTER UPDATE OF bio, deleted_at ON users FOR EACH ROW
  WHEN (OLD.bio IS DISTINCT FROM NEW.bio OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at) EXECUTE FUNCTION ol_users_hashtags_trg();

-- backfill (idempotent)
INSERT INTO message_hashtags (tag, message_id, conversation_id, created_at)
  SELECT x, d.id, d.conversation_id, d.created_at FROM dms d, unnest(ol_hashtags(d.text)) AS x
  WHERE d.kind IS NULL AND strpos(d.text, '#') > 0
  ON CONFLICT DO NOTHING;
INSERT INTO message_mentions (handle, message_id, user_id, conversation_id, created_at)
  SELECT x, d.id, (SELECT u.id FROM users u WHERE u.username = x LIMIT 1), d.conversation_id, d.created_at
  FROM dms d, unnest(ol_mentions(d.text)) AS x
  WHERE d.kind IS NULL AND strpos(d.text, '@') > 0
  ON CONFLICT DO NOTHING;
INSERT INTO room_hashtags (tag, room_id)
  SELECT x, r.id FROM rooms r, unnest(ol_hashtags(r.title || E'\n' || r.description)) AS x
  WHERE strpos(r.title || ' ' || r.description, '#') > 0
  ON CONFLICT DO NOTHING;
INSERT INTO user_hashtags (tag, user_id)
  SELECT x, u.id FROM users u, unnest(ol_hashtags(u.bio)) AS x
  WHERE u.deleted_at IS NULL AND strpos(u.bio, '#') > 0
  ON CONFLICT DO NOTHING;
INSERT INTO hashtags (tag, created_at)
  SELECT tag, (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT FROM (
    SELECT tag FROM message_hashtags UNION SELECT tag FROM room_hashtags UNION SELECT tag FROM user_hashtags
  ) t
  ON CONFLICT DO NOTHING;
