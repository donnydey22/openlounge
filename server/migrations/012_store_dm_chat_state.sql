-- 012_store_dm_chat_state: per-user inbox state for 1:1 chats (Telegram-style pin / "Delete chat for me").
-- Additive + idempotent. hidden_at: messages at or before it are hidden for user_id only (the peer keeps everything);
-- a newer message brings the chat back. Nothing else references this table.
CREATE TABLE IF NOT EXISTS dm_chat_state (
  user_id    TEXT NOT NULL,
  peer_id    TEXT NOT NULL,
  pinned_at  BIGINT,
  hidden_at  BIGINT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, peer_id)
);
