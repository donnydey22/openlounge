-- 006: social links on the user profile. Additive and idempotent.
-- JSONB object of canonical https URLs keyed by network (instagram, x, tiktok, youtube, linkedin, snapchat,
-- telegram, threads, website). Validated/normalized by the app (src/lib/socialLinks.ts) before writing.
ALTER TABLE users ADD COLUMN IF NOT EXISTS social_links JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_social_links_object') THEN
    ALTER TABLE users ADD CONSTRAINT users_social_links_object CHECK (jsonb_typeof(social_links) = 'object' AND pg_column_size(social_links) < 4096);
  END IF;
END $$;
COMMENT ON COLUMN users.social_links IS 'canonical https profile URLs keyed by network; {} = none';
