-- 008: hardening — DM idempotency key + indexes for hot queries. Idempotent (IF NOT EXISTS everywhere).
-- Runs inside the migration runner's transaction under the advisory lock (see pg.ts). Tables are small today,
-- so plain CREATE INDEX (brief lock) is fine; for large tables switch to CONCURRENTLY outside a transaction.

-- dm:send idempotency: the client's clientId is persisted so a retry after a restart/redeploy is still de-duplicated.
ALTER TABLE dms ADD COLUMN IF NOT EXISTS client_id TEXT;
-- not UNIQUE on purpose: pre-existing duplicate rows (sent before this fix) must not wedge the snapshot save
CREATE INDEX IF NOT EXISTS dms_client_idx ON dms (from_id, client_id) WHERE client_id IS NOT NULL;

-- DMs by thread/time: newest-first paging (dm:history before=…) and stable (created_at, id) ordering
CREATE INDEX IF NOT EXISTS dms_conversation_desc_idx ON dms (conversation_id, created_at DESC, id DESC);
-- sender side of catch-up (dm:since for messages I sent from another device)
CREATE INDEX IF NOT EXISTS dms_from_idx ON dms (from_id, created_at);
-- global load order used at boot (ORDER BY created_at, id)
CREATE INDEX IF NOT EXISTS dms_created_idx ON dms (created_at, id);

-- rooms: listing + "rooms hosted by"
CREATE INDEX IF NOT EXISTS rooms_created_idx ON rooms (created_at, id);
CREATE INDEX IF NOT EXISTS rooms_host_idx ON rooms (host_id);

-- presence "last seen" per user (max(last_seen_at) over a user's sessions)
CREATE INDEX IF NOT EXISTS sessions_user_seen_idx ON sessions (user_id, last_seen_at DESC);

-- read receipts: who has read my messages (peer side lookup)
CREATE INDEX IF NOT EXISTS dm_reads_peer_idx ON dm_reads (peer_id, user_id);

-- phone sign-in lookup
CREATE INDEX IF NOT EXISTS users_phone_idx ON users (phone) WHERE phone IS NOT NULL;
