-- Generic platform audio admission only; no call lifecycle, session keys, signaling or media state.
CREATE TABLE IF NOT EXISTS platform_audio_leases (
 user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 owner text NOT NULL, expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS platform_audio_leases_expiry ON platform_audio_leases(expires_at);
