-- 032: "Live now" inbox + weekly "Trending live" pick (additive, idempotent).
--  live_notices: one row per (user, room) the user was told is live (followed host started / joined / speaking,
--  popular with people you follow, live again, scheduled room now live, trending live). The newest notice for a
--  room replaces the older one and makes it unread again; rows are deleted when the room ends, and at most
--  LIVE_INBOX_MAX per user are kept. No FK to users: account deletion removes them (PushRepo.deleteUserData path).
--  trending_live_sends: who got the weekly pick in which ISO week (UTC, "2026-W41"). The primary key is the
--  idempotency claim, so two schedulers (deploy overlap) can never send the same user two picks in one week.
CREATE TABLE IF NOT EXISTS live_notices (
  user_id   TEXT    NOT NULL,
  room_id   TEXT    NOT NULL,
  type      TEXT    NOT NULL,
  actor_id  TEXT,
  title     TEXT    NOT NULL,
  body      TEXT    NOT NULL,
  url       TEXT    NOT NULL,
  at        BIGINT  NOT NULL,
  read_at   BIGINT,
  PRIMARY KEY (user_id, room_id)
);
CREATE INDEX IF NOT EXISTS live_notices_room_idx ON live_notices (room_id);
CREATE INDEX IF NOT EXISTS live_notices_user_at_idx ON live_notices (user_id, at DESC);
CREATE TABLE IF NOT EXISTS trending_live_sends (
  user_id  TEXT        NOT NULL,
  week     TEXT        NOT NULL,
  room_id  TEXT        NOT NULL,
  sent_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, week)
);
