# feat/live-notify-gaps — WIP status (paused Oct 10, 8:53 PM PT)

## Done
- Server: migration 032 (live_notices, trending_live_sends); server/push/liveInbox.ts (Memory + Pg); LIVE_COPY in
  notifier.ts (Clubhouse wording: "Maya started a room" / "<title> · tap to join"; joined, speaking, live again,
  scheduled-now-live, trending live); roomSpeaking trigger (host:invite); Live now inbox fed from deliver() (silent,
  keeps quiet-hours/throttled notices); auto-clear on room end; WS notify:inbox / notify:inboxRead / notify:inboxEnded;
  weekly Trending live pick (server/push/trendingLive.ts, hourly scheduler, (user, ISO week) claim, idempotent);
  pref trendingLive (on by default); rooms:update carries liveIds.
- Client: /live page (Live now list), bell in TopBar with green unread badge, src/lib/liveNow.ts store,
  Avatar `live` ring (squircle, green, 3 pulses then static; reduced-motion / data-lowend / data-nowhere static),
  wired into UserRow, DM list, profile header, hallway room cards (host); Settings → Notifications toggle.
- Verified: typecheck ✓, build ✓, test:push 28/28 (5 new tests), hardening unit 14, presence 9, calls 40,
  invites 20, store 15 all pass; migration 032 applied on local Postgres; ring test 14/14 in chromium, firefox, webkit.

## Not done (next steps)
1. QA layout matrix (/workspace/qa/run-matrix.sh --base http://127.0.0.1:3414 / /live /settings/notifications /messages),
   especially TopBar fit at 280px with the extra bell icon.
2. Screenshots into /workspace/live-notify/shots/.
3. Open PR into main (do NOT merge).
4. iPhone push test command (scripts/test-push.ts / server/push) for Donny's account; not sent.
