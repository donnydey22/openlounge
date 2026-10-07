-- Username sign-in (@username + password, or @username → one-time code to the account's verified email).
-- Numbered 012: 010 is email OTP (email-otp branch, this branch's base) and 011 is reserved by the ugc-safety branch.
--
-- 1. email_otp_codes gains purpose 'username': key 'username:<user id>:', email = the masked destination's real address.
--    Same rules as 010: HMAC-SHA256 keyed hash, 10 min, max 5 attempts, single use.
-- 2. users.password_hash is now the ACCOUNT password (email+password and @username+password share it); removing the
--    last email identity no longer clears it. Lookup by username is case-insensitive: usernames are stored lower-cased
--    (store.normalizeUsername); the index below backs that lookup for the Postgres paths.
-- Idempotent.

ALTER TABLE email_otp_codes DROP CONSTRAINT IF EXISTS email_otp_codes_purpose_check;
ALTER TABLE email_otp_codes ADD CONSTRAINT email_otp_codes_purpose_check CHECK (purpose IN ('signin', 'link', 'username'));

CREATE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));

COMMENT ON COLUMN users.password_hash IS 'scrypt account password (email + password and @username + password sign-in); null = none set';
