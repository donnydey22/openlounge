-- 023: 1:1 audio/video calls — a DM can be a call service message ('call'): Outgoing / Incoming / Missed / Declined /
-- Cancelled / Busy with duration. room_id holds the call id ("call-<uuid>"), call holds the outcome JSON
-- ({id, callerId, video, outcome, durationSec}). Additive + idempotent: the kind check is widened, nothing is dropped.

ALTER TABLE dms ADD COLUMN IF NOT EXISTS call JSONB;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_kind_check') THEN
    ALTER TABLE dms DROP CONSTRAINT dms_kind_check;
  END IF;
  ALTER TABLE dms ADD CONSTRAINT dms_kind_check CHECK (kind IS NULL OR kind IN ('room_invite', 'dropin', 'call'));
END $$;

COMMENT ON COLUMN dms.call IS 'kind = call: {id, callerId, video, outcome, durationSec}';
