-- Rename to Open Lounge: the meta table becomes openlounge_meta. Idempotent.
-- Handles a database that ran 001 (clubroom_meta) and one that ran an unreleased dev build of this file (lounge_meta).
DO $$
DECLARE
  old_name text;
BEGIN
  FOREACH old_name IN ARRAY ARRAY['lounge_meta', 'clubroom_meta'] LOOP
    IF to_regclass(old_name) IS NOT NULL THEN
      IF to_regclass('openlounge_meta') IS NULL THEN
        EXECUTE format('ALTER TABLE %I RENAME TO openlounge_meta', old_name);
        EXECUTE format('ALTER INDEX IF EXISTS %I RENAME TO openlounge_meta_pkey', old_name || '_pkey');
      ELSE
        EXECUTE format('INSERT INTO openlounge_meta (key, value, updated_at) SELECT key, value, updated_at FROM %I ON CONFLICT (key) DO NOTHING', old_name);
        EXECUTE format('DROP TABLE %I', old_name);
      END IF;
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS openlounge_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
