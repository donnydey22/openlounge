-- 034: message permanence (additive, idempotent; nothing is altered or dropped).
--  * message_tombstones — "This message was deleted" placeholders for DM / group messages deleted for everyone.
--                         Content-free (no text, no media): the dms row still leaves (030 archive unchanged); the
--                         placeholder keeps the bubble's place in history for every member, forever.
--  * room_messages      — live-room chat, kept forever (was memory-only, last 200). data = the ChatMessage JSON;
--                         deleted_at set (and text scrubbed) when deleted for everyone.
CREATE TABLE IF NOT EXISTS message_tombstones (
  message_id      TEXT   PRIMARY KEY,
  conversation_id TEXT   NOT NULL,
  from_id         TEXT   NOT NULL,
  from_name       TEXT   NOT NULL,
  from_color      TEXT   NOT NULL,
  to_id           TEXT   NOT NULL,
  created_at      BIGINT NOT NULL,
  deleted_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS message_tombstones_conv_idx ON message_tombstones (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS room_messages (
  id         TEXT   PRIMARY KEY,
  room_id    TEXT   NOT NULL,
  created_at BIGINT NOT NULL,
  data       JSONB  NOT NULL,
  deleted_at BIGINT
);
CREATE INDEX IF NOT EXISTS room_messages_room_idx ON room_messages (room_id, created_at, id);
