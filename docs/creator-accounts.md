# Creator & business accounts

Flag: `CREATOR_ENABLED` (off by default). While it's off, every endpoint except `/api/creator/config` refuses,
`/api/badges` returns no verified badges, `/api/r/<slug>` 404s and rooms show no branding.

## Pieces
- **Account**: `/creator` → turn on a creator or business account (free).
- **Verification badge** (blue check = creator, gold = business):
  - Form: legal name, country, optional website; government ID (JPG/PNG/WebP/PDF ≤ 8 MB); businesses also upload a registration document.
  - Images are re-encoded (EXIF/GPS stripped), PDFs header-checked, stored as private `0600` files in `VERIFY_DOCS_DIR`
    (default `$DATA_DIR/verify-docs`), viewable only by admins (`no-store`), and **deleted as soon as the request is decided**.
  - Fee: `VERIFY_CREATOR_CENTS` (1499) / `VERIFY_BUSINESS_CENTS` (4999), paid on the **web only** through the shared PayPal
    checkout (product ref `verify:<kind>:<requestId>`, item name "Open Lounge creator/business verification"). The phone apps show
    status only, no buy button and no purchase link. `VERIFY_FEE_WAIVED=1` skips the fee.
  - Admin review at `/admin/creator`: approve / reject with a reason / revoke. A PayPal refund revokes the badge automatically.
    Rejecting doesn't refund by itself.
- **Analytics** (aggregate only, no listener lists stored): every `CREATOR_SAMPLE_MS` (60 s) the server samples live public rooms
  hosted by creator accounts → unique listeners, peak concurrency, listening minutes, concurrency curve, 5/15/30/60-min
  retention (null until it can be known), daily follower snapshot. Replays: counter hook `creator().countReplay(roomId)`;
  nothing calls it yet because rooms aren't recorded.
- **Branded rooms**: display name, custom link `openlounge.app/r/<slug>` (public, opens signed out), accent/background colors,
  logo + cover (re-encoded to WebP under `CREATOR_FILES_DIR`, served from `/creator-files/`), co-host list, weekly series
  in the host's time zone (shown as "Upcoming" on the brand page). Rooms by a branded host show a brand strip at the top.

## Not done yet
- Co-host **powers** in live rooms: the list is stored and `creator().isCoHost(hostId, userId)` exists, but the room server
  (`server/realtime.ts`) doesn't consult it yet. Wiring it means a small check in the room moderation path, owned by the rooms worker.
- Replays need room recordings first.

## Tables (migration 028_creator, additive)
`creator_profiles`, `verification_requests`, `user_badges`, `room_branding`, `room_series`, `creator_room_sessions`,
`creator_follower_daily`. Each one has `id`, a few mirrored columns, `data JSONB` and `updated_at`.
