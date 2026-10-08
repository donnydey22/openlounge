-- Store compliance: operator-provisioned internal accounts (App Review demo login, QA). A row asks the running server
-- (server/deletionQueue.ts) to create a screen-name + password account; only the scrypt hash is ever stored here.
-- Additive only.
CREATE TABLE IF NOT EXISTS account_provisioning_requests (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL,
  requested_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
  processed_at BIGINT,
  user_id TEXT,
  result TEXT
);
CREATE INDEX IF NOT EXISTS account_provisioning_requests_pending ON account_provisioning_requests (requested_at) WHERE processed_at IS NULL;
