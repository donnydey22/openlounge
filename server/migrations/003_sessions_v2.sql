-- Sessions v2: short-lived access tokens + rotating refresh tokens (see server/auth.ts).
-- Extends the existing `sessions` table in place and backfills every existing row so the tokens people
-- (and test bots) already hold keep working: they become "legacy" refresh-able sessions (scheme 1,
-- legacy_hash = token_hash) with a 90-day sliding refresh window. Idempotent; never drops data.
--
--   token_hash         SHA-256 of the current refresh token (PK, unchanged)
--   id                 stable session/family id carried inside access tokens
--   created_at         created            last_seen_at  last used
--   access_expires_at  expiry of the latest access token issued
--   expires_at         refresh expiry (sliding)
--   revoked_at         revoked flag (logout / refresh-token reuse); row kept until expires_at
--   device             device / platform label
--   confirmed_at       first use of the current refresh generation (NULL = rotated, new token not yet seen in use;
--                      the previous token is then still accepted so a lost /auth/refresh response never signs anyone out)

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id                TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS scheme            SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS legacy_hash       TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS prev_hashes       TEXT[]   NOT NULL DEFAULT '{}';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS rotated_at        BIGINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS access_expires_at BIGINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at        BIGINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device            TEXT     NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS confirmed_at      BIGINT;

-- Backfill: existing tokens stay valid as legacy refresh-able sessions.
UPDATE sessions SET id = 's_' || substr(token_hash, 1, 32) WHERE id IS NULL;
UPDATE sessions SET legacy_hash = token_hash WHERE scheme = 1 AND legacy_hash IS NULL;
-- 60-day sliding -> 90-day sliding refresh window (never shortens a session)
UPDATE sessions SET expires_at = GREATEST(expires_at, last_seen_at + 7776000000) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS sessions_id_idx     ON sessions (id);
CREATE INDEX IF NOT EXISTS sessions_legacy_idx ON sessions (legacy_hash) WHERE legacy_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_prev_idx   ON sessions USING GIN (prev_hashes);

COMMENT ON COLUMN sessions.expires_at IS 'refresh-token expiry (epoch ms, 90-day sliding)';
COMMENT ON COLUMN sessions.last_seen_at IS 'last used (epoch ms)';
COMMENT ON COLUMN sessions.access_expires_at IS 'expiry of the most recently issued access token (epoch ms)';
COMMENT ON COLUMN sessions.revoked_at IS 'revoked flag: set on logout or refresh-token reuse (epoch ms)';
