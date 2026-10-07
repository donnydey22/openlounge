-- 005: time correctness audit. Idempotent and non-destructive.
-- App timestamps are epoch milliseconds (BIGINT), i.e. UTC by definition, and are what ws/REST send.
-- The only SQL-native timestamps are TIMESTAMPTZ (follows.created_at, openlounge_meta.updated_at).
-- Safety net: any "timestamp without time zone" column in this schema (e.g. one added by hand) is converted
-- to TIMESTAMPTZ, reading the existing wall-clock values as UTC. The values themselves don't change.
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND data_type = 'timestamp without time zone'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE timestamptz USING %I AT TIME ZONE ''UTC''', c.table_name, c.column_name, c.column_name);
    RAISE NOTICE 'converted %.% to timestamptz (as UTC)', c.table_name, c.column_name;
  END LOOP;
END $$;

COMMENT ON COLUMN dms.created_at IS 'server time the message was stored (epoch ms, UTC); strictly increasing per conversation';
COMMENT ON COLUMN users.created_at IS 'epoch ms, UTC';
COMMENT ON COLUMN rooms.created_at IS 'epoch ms, UTC';
COMMENT ON COLUMN sessions.created_at IS 'epoch ms, UTC';
COMMENT ON COLUMN dm_reads.last_read_at IS 'epoch ms, UTC';
