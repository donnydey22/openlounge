-- DM read receipts (sent ✓ / seen ✓✓): per-message read_at (epoch ms, NULL = not seen yet).
-- dm_reads (per-conversation last-read pointer) stays the source for unread counts; read_at is what the
-- sender sees. Backfill: everything at or before the recipient's existing read pointer counts as seen at that
-- pointer's time (best estimate we have). Idempotent: only fills NULLs; safe to re-run.

ALTER TABLE dms ADD COLUMN IF NOT EXISTS read_at BIGINT;

UPDATE dms d
   SET read_at = GREATEST(r.last_read_at, d.created_at)
  FROM dm_reads r
 WHERE d.read_at IS NULL
   AND r.user_id = d.to_id
   AND r.peer_id = d.from_id
   AND d.created_at <= r.last_read_at;

-- "what hasn't this person seen from that sender yet" (marking read, receipts)
CREATE INDEX IF NOT EXISTS dms_unseen_idx ON dms (to_id, from_id, created_at) WHERE read_at IS NULL;

COMMENT ON COLUMN dms.read_at IS 'when the recipient saw this message (epoch ms); NULL = delivered/sent, not seen';
