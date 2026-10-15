# Incoming-call ring when the tab is hidden

Open Lounge keeps an audible incoming-call ring going while the tab is focused (Web Audio + `<audio>` fallback in `src/lib/calls/tones.ts`). When the tab is **hidden** or the **device is locked**, browsers throttle or suspend page audio. This document is the honest limit list and what we do instead.

## What browsers allow

| Environment | In-page Web Audio / `<audio>` ring | What we use instead |
|---|---|---|
| Tab focused | Full ~45 s ring | — |
| Tab in background (Chrome / Edge / Firefox desktop) | Usually **suspended** within seconds; `setInterval` heavily throttled | Service-worker notification with `requireInteraction`, `renotify`, `vibrate`, Accept/Decline; re-shown every ~3 s until answer / decline / expiry (`public/sw.js`) |
| Mobile Chrome / Firefox (tab backgrounded or screen off) | Same suspension; media often blocked without a media session / ongoing notification | Same SW notification; OS may still mute notification sound in DND |
| Safari (macOS / iOS) | Aggressive audio suspension; SW notification actions limited | SW notification (actions may be missing on Safari); user must tap the notification |
| Native Android / iOS apps | WebView audio also suspends when backgrounded | **Not this path** — FCM CallStyle / CallKit ring (see NATIVE_SPEC). App Lock reports `presence:visible false` so that native ring fires. |

## What we guarantee

1. **Focused tab** — in-page ring for the server ring window (~45 s).
2. **Hidden tab** — `presence:visible` is false, so the server also sends the call push; the page asks the SW to show an insistent call notification and keeps trying to resume AudioContext / replay the looped element for as long as the OS allows.
3. **Accept / Decline** on the notification (where the browser supports `actions`) navigate or post a message to the open client.

## What we do **not** guarantee

- A continuous multi-decade-style ringtone from a backgrounded web tab (no browser allows that without a native/OS call UI).
- Notification sound while the user has system DND / focus mode silencing alerts.
- Safari notification action buttons (Accept/Decline may degrade to “tap notification”).

## Related code

- `src/lib/calls/backgroundRing.ts` — page-side keepalive + SW messages
- `public/sw.js` — insistent call notification loop
- `src/lib/realtime.ts` — `appVisible()` / App Lock → `presence:visible`
- Native: Android `CallNotifications` / iOS CallKit (separate from this web path)
