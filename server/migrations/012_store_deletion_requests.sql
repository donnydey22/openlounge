-- Store compliance: operator-initiated account deletions (support/email requests, test-account cleanup).
-- A row is a request; the running server picks it up (server/deletionQueue.ts), runs the same deletion as
-- Settings > Delete account (tombstone + PII scrub + push data), and stamps processed_at / result. Additive only.
CREATE TABLE IF NOT EXISTS account_deletion_requests (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  requested_at BIGINT NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint,
  processed_at BIGINT,
  result TEXT
);
CREATE INDEX IF NOT EXISTS account_deletion_requests_pending ON account_deletion_requests (requested_at) WHERE processed_at IS NULL;
