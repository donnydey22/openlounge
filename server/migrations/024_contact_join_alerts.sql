-- 024: "Tell me when contacts join" (new-people notifications). Rows uploaded while the owner has the switch on are
-- kept (keep = true) instead of being purged after 24 h; turning it off deletes them. Additive + idempotent.
ALTER TABLE contact_hashes ADD COLUMN IF NOT EXISTS keep BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS contact_hashes_purge_idx ON contact_hashes (created_at) WHERE NOT keep;
