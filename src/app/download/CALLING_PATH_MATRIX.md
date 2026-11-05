# Open Lounge Calling Path Matrix — Standing Requirement

Owner: Donny Dey. Applies to iPhone b103, Android build 43, and **every calling change after**.
This file is documentation only; it does not change the /download page output.

## Requirement
1. One-to-one **audio AND video** must work on every direction and surface:
   iPhone↔Android, Android↔Android, iPhone↔iPhone, web↔iPhone, web↔Android.
2. **P2P first on all of them**, including web (web calling uses the **Wasm engine**).
3. Connectivity handling is **Telegram-style and simple**: direct connection first, relay fallback, reconnect on network change. No extra layers.
4. Code source hierarchy — nothing invented:
   1. WhatsApp's public calling information (engineering posts, writeups, patents, public docs) — cite the source.
   2. Telegram's public repositories (github.com/DrKLO/Telegram Android VoIP service; Telegram iOS CallKitIntegration / ManagedAudioSession / PresentationCall) where WhatsApp's public info is silent.
5. "Connected" means media flowing both ways. Binary — no silent connects.

## Checklist (every calling diff must fill this in before merge)

| # | Direction | Audio: P2P | Audio: relay fallback | Audio: reconnect | Video: P2P | Video: relay fallback | Video: reconnect | Source (WhatsApp / Telegram ref) |
|---|-----------|-----------|-----------------------|------------------|-----------|-----------------------|------------------|----------------------------------|
| 1 | iPhone → Android  | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 2 | Android → iPhone  | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 3 | Android → Android | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 4 | iPhone → iPhone   | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 5 | Web → iPhone      | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 6 | iPhone → Web      | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 7 | Android → Web     | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 8 | Web → Android     | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | |

For each row a box is checked only when a real call in that direction connected with media flowing both ways (audio heard / video frames received on both ends).
