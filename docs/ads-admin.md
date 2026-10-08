# Ads admin: one hub for every sponsored placement

Open Lounge has two sponsored systems. Both are off by default, and admins manage both from one admin
(`AdsAdminNav` appears on both pages):

| Tab | Page | Owner | What |
|-----|------|-------|------|
| Rooms & ads | `/admin/ads` | monetization (`server/ads/*`) | Sponsored rooms (a host's live room featured at the top of the hallway and in Explore) and highlighted ad cards: booking (advertiser, contact, price, reference, notes) and scheduling (start/end, per-person daily cap, weight) |
| Review queue | `/admin/ads?tab=review` | monetization | draft → pending_review → approved / rejected (a note is required to reject); creative edits send a campaign back to review |
| Report | `/admin/ads?tab=report` | monetization | Aggregate daily impressions / clicks / joins / CTR per campaign and placement, plus CSV export |
| In-chat messages | `/admin/sponsored` | layout (`server/sponsored.ts`, `/sp/*`) | Telegram-style sponsored messages (bottom of the room list, large groups), master switch, hide/report |

## Switches
- Sponsored rooms & cards: env `ADS_ENABLED` (unset = off). While it is off, admins can still book, schedule and
  review campaigns. `/api/ads/slot` returns nothing.
- In-chat messages: the DB master switch in `/admin/sponsored`, plus each ad's own enabled toggle.

## Privacy rules (both systems)
- No third-party SDKs, pixels or cookies. Ads are never targeted at a person.
- Rooms & ads: the server counts an impression when it serves a slot. A click or join counts once per person per day
  and only after that person was served the slot. Only aggregate rows are stored
  (`ad_stats_daily`: day × campaign × placement). The frequency cap is kept in memory for the day; nothing per
  person is saved.
- In-chat messages store per-person hides and reports only. They don't log views or clicks.

## One sponsored item per view
The hallway can show the featured slot (top, `FeaturedSponsored placement="hallway"`) and the in-chat
`SponsoredSlot placement="rooms"` (bottom). Proposal for the layout owner: `SponsoredSlot` skips rendering when
`document.querySelector('[data-testid="featured-sponsored"]')` exists (or listen for the featured card's mount).
Then a view never shows two sponsored items. Both are off today, so nothing shows either way.

## Contract for adding a placement
- Room/explore-style placements: add the id to `AD_PLACEMENTS` (`src/lib/ads/types.ts`), render
  `<FeaturedSponsored placement="…">`, and the admin checkbox appears automatically.
- If in-chat messages want the shared review queue or report later, give them a `status` in the same states
  (`draft | pending_review | approved | rejected | paused`). The review tab can list them through a small
  `GET /sp/admin?status=pending_review` endpoint, and the counters can reuse `ad_stats_daily` with placement
  `"chat"`. That's optional and needs no schema change on our side.
