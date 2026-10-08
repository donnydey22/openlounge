-- 013: audio rooms in DMs — a DM can be a live room invite card ('room_invite') or a drop-in audio chat card
-- ('dropin') pointing at a room. The card's live state (listeners, speakers, Ended) is never stored: it is computed
-- from the in-memory room and pushed over the WebSocket. Plain text DMs keep both columns NULL. Idempotent.

ALTER TABLE dms ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE dms ADD COLUMN IF NOT EXISTS room_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_kind_check') THEN
    ALTER TABLE dms ADD CONSTRAINT dms_kind_check CHECK (kind IS NULL OR kind IN ('room_invite', 'dropin'));
  END IF;
END $$;

COMMENT ON COLUMN dms.kind IS 'NULL = text message; room_invite | dropin = live audio room card (room_id set)';
COMMENT ON COLUMN dms.room_id IS 'room the invite / drop-in card points at (kind set)';
