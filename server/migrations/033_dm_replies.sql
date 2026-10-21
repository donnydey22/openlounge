-- Telegram/WhatsApp-style replies keep a small trusted quote snapshot. The referenced message
-- may later be trimmed or deleted, while the reply still renders safely without media URLs.
ALTER TABLE dms ADD COLUMN IF NOT EXISTS reply_to JSONB;
