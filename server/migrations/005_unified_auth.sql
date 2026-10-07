-- Unified auth (one account, many sign-in methods): phone, email+password, Google, Apple.
-- Additive and idempotent: nothing is dropped or rewritten; existing users, sessions and phone login keep working.
--
--   auth_identities         one row per sign-in method attached to a user. Phone numbers are identities too
--                           (provider 'phone', subject = E.164). users.phone stays as a mirror of the phone identity
--                           (older code paths, /auth/validate's phoneMasked) — it is never the only copy.
--   users.password_hash     scrypt hash for accounts that have an email identity (NULL = no password)
--   password_reset_tokens   SHA-256 of a one-time reset link token, ~30 min, single use
--   auth_one_time_codes     SHA-256 of other short-lived single-use codes: email verification links, the
--                           OAuth -> app/web one-time exchange code, "link a provider" intents
-- Timestamps are epoch milliseconds (BIGINT), like the rest of the schema.

CREATE TABLE IF NOT EXISTS auth_identities (
  user_id          TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT    NOT NULL CHECK (provider IN ('phone', 'email', 'google', 'apple')),
  provider_subject TEXT    NOT NULL,              -- phone: E.164 · email: lower-cased address · google/apple: the `sub` claim
  email            TEXT,                          -- lower-cased; for email identities = provider_subject
  verified         BOOLEAN NOT NULL DEFAULT false, -- the provider (or our link / OTP) proved control of it
  created_at       BIGINT  NOT NULL,
  last_used_at     BIGINT,
  CONSTRAINT auth_identities_provider_subject_key UNIQUE (provider, provider_subject)
);
CREATE INDEX IF NOT EXISTS auth_identities_user_idx ON auth_identities (user_id);
-- account linking looks up verified emails across providers
CREATE INDEX IF NOT EXISTS auth_identities_verified_email_idx ON auth_identities (lower(email)) WHERE verified AND email IS NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash  TEXT   PRIMARY KEY,                 -- SHA-256 (hex) of the token in the emailed link
  user_id     TEXT   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT   NOT NULL,                    -- address the link was sent to (becomes/keeps the email identity)
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  used_at     BIGINT                              -- single use: set when consumed (or when superseded)
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens (user_id);

CREATE TABLE IF NOT EXISTS auth_one_time_codes (
  code_hash   TEXT   PRIMARY KEY,                 -- SHA-256 (hex) of the code
  purpose     TEXT   NOT NULL,                    -- 'verify_email' | 'exchange' | 'link_intent'
  payload     JSONB  NOT NULL DEFAULT '{}'::jsonb, -- never contains session tokens
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  used_at     BIGINT
);
CREATE INDEX IF NOT EXISTS auth_one_time_codes_expires_idx ON auth_one_time_codes (expires_at);

-- Backfill: every existing phone number becomes a verified phone identity (OTP already proved it).
INSERT INTO auth_identities (user_id, provider, provider_subject, email, verified, created_at)
SELECT id, 'phone', phone, NULL, true, created_at FROM users WHERE phone IS NOT NULL
ON CONFLICT (provider, provider_subject) DO NOTHING;

COMMENT ON TABLE auth_identities IS 'sign-in methods per user (phone/email/google/apple); unique (provider, provider_subject)';
COMMENT ON COLUMN users.password_hash IS 'scrypt$N$r$p$salt$hash (base64url); NULL = no password';
