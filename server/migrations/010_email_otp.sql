-- Email sign-in with a 6-digit code (like SMS OTP) + "add email" from Settings.
-- One live code per (purpose, user, email): requesting a new one replaces the old row (attempts reset).
--   code_hash  HMAC-SHA256 (server key) of key + code — 6 digits are guessable, so a keyed hash, never plain SHA-256
--   attempts   wrong + right tries; refused at 5 (request a new code)
-- Timestamps are epoch milliseconds (BIGINT), like the rest of the schema.

CREATE TABLE IF NOT EXISTS email_otp_codes (
  otp_key     TEXT    PRIMARY KEY,                 -- '<purpose>:<user id or empty>:<email>'
  email       TEXT    NOT NULL,                    -- lower-cased address the code was sent to
  purpose     TEXT    NOT NULL CHECK (purpose IN ('signin', 'link')),
  user_id     TEXT    REFERENCES users(id) ON DELETE CASCADE, -- link: the signed-in account adding this email
  code_hash   TEXT    NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  BIGINT  NOT NULL,
  expires_at  BIGINT  NOT NULL,
  used_at     BIGINT
);
CREATE INDEX IF NOT EXISTS email_otp_codes_expires_idx ON email_otp_codes (expires_at);

COMMENT ON TABLE email_otp_codes IS 'hashed 6-digit email sign-in / link codes: 10 min, max 5 attempts, single use';
