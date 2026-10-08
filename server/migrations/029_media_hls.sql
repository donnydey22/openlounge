-- 029: adaptive video + media cache. Additive, idempotent.
-- rev: URL version for /media/<id>/v<rev>/… (bumped when a file is regenerated → new URLs, no cache purge needed).
-- HLS ladder state lives in media.files ("hls" / "hlsLow" entries with rungs + final), so no other column is needed.
ALTER TABLE media ADD COLUMN IF NOT EXISTS rev INTEGER NOT NULL DEFAULT 1;
