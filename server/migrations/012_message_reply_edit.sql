-- 012: reply context + author edits for durable direct messages.
-- Reply context is a small server-authored snapshot so a later edit/delete never rewrites history.
ALTER TABLE dms ADD COLUMN IF NOT EXISTS reply_to JSONB;
ALTER TABLE dms ADD COLUMN IF NOT EXISTS edited_at BIGINT;

CREATE INDEX IF NOT EXISTS dms_edited_at_idx ON dms (edited_at) WHERE edited_at IS NOT NULL;
