-- 033: live (calling/ringing/active) 1:1 call state, so a deploy/restart/crash of the app server doesn't drop calls.
-- Additive. One row per live call; deleted when the call ends. Media lives on the SFU/LiveKit, which an app deploy
-- does not restart: on boot the server restores these rows and both clients re-attach by call id.
CREATE TABLE IF NOT EXISTS live_calls (
  id          TEXT PRIMARY KEY,
  caller_id   TEXT NOT NULL,
  callee_id   TEXT NOT NULL,
  state       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
