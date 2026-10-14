-- 032: Durable audience for Clubhouse-style room activity notifications.
-- Members who explicitly joined a public room are retained only as a short-lived host/user pair. The data is not a
-- room transcript or presence log; it allows the next process after a deploy/restart to notify recent participants
-- when that host starts another room. No FKs: accounts and rooms are snapshot-flushed asynchronously.
CREATE TABLE IF NOT EXISTS room_activity_members (
  host_id        TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  last_joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (host_id, user_id)
);
CREATE INDEX IF NOT EXISTS room_activity_members_recent_idx ON room_activity_members (host_id, last_joined_at DESC);
