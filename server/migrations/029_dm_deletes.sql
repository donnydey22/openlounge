-- 029: Telegram-style message deletion for 1:1 chats (additive, idempotent).
--  * dm_hidden   — "Delete for me": per-viewer hidden message ids. No FK to dms on purpose (dms rows are written by the
--                  debounced snapshot, a hide can arrive first); orphans are pruned on boot.
--  * dm_deleted  — "Delete for everyone" keeps a short-lived archive (the soft delete) so a report filed just before
--                  the delete can still be reviewed. The live row leaves dms (so search indexes / triggers / history
--                  forget it everywhere); the archive is pruned after 30 days and on account deletion.
CREATE TABLE IF NOT EXISTS dm_hidden (
  user_id    TEXT   NOT NULL,
  message_id TEXT   NOT NULL,
  hidden_at  BIGINT NOT NULL,
  PRIMARY KEY (user_id, message_id)
);

CREATE TABLE IF NOT EXISTS dm_deleted (
  message_id      TEXT   PRIMARY KEY,
  conversation_id TEXT   NOT NULL,
  from_id         TEXT   NOT NULL,
  to_id           TEXT   NOT NULL,
  text            TEXT   NOT NULL,
  created_at      BIGINT NOT NULL,
  deleted_at      BIGINT NOT NULL,
  deleted_by      TEXT   NOT NULL
);
CREATE INDEX IF NOT EXISTS dm_deleted_from_idx ON dm_deleted (from_id);
CREATE INDEX IF NOT EXISTS dm_deleted_at_idx ON dm_deleted (deleted_at);
