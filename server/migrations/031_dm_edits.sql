-- 031: Telegram-style message editing (additive, idempotent).
--  dm_edits: when a message was last edited and how many times. The edited text itself lives in dms.text (written by the
--  normal snapshot upsert), so migration 020's triggers keep hashtags / mentions / FTS in sync with no extra work.
--  No FK to dms on purpose (dms rows are written by the debounced snapshot; an edit row can land first); orphans are
--  pruned on boot, like dm_hidden.
CREATE TABLE IF NOT EXISTS dm_edits (
  message_id TEXT    PRIMARY KEY,
  edited_at  BIGINT  NOT NULL,
  edit_count INTEGER NOT NULL DEFAULT 1
);
