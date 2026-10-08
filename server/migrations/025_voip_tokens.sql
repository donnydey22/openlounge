-- 025: iOS PushKit VoIP tokens for CallKit ringing (iPhone build 18). Additive. Kept apart from device_tokens so the FCM sender
-- never tries to deliver ordinary pushes to a PushKit token (and Apple's "every VoIP push must ring" rule stays easy to honour).
CREATE TABLE IF NOT EXISTS voip_tokens (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  apns_env   TEXT NOT NULL DEFAULT 'production' CHECK (apns_env IN ('production', 'sandbox')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voip_tokens_user_idx ON voip_tokens (user_id);
