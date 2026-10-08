# Contacts — privacy policy section (Find friends from contacts)

*Draft text for the Open Lounge privacy policy. Also shown in-app at /privacy/contacts.*

## What we collect, and only if you choose to
"Find friends from contacts" is optional. Open Lounge never reads your address book unless you tap **Find friends**,
read our explanation, tap **Continue**, and then allow access in your phone's permission prompt. If you decline, every
other part of the app works the same, and you can change your mind later in your phone's Settings.

When you turn it on, your phone:
1. reads the phone numbers in your contacts **on the device**;
2. converts each number to international format (E.164, e.g. +14155550123);
3. turns each number into a one-way code (a SHA-256 hash) and sends **only those codes** to us.

Contact names, emails, photos, notes and any other fields **never leave your phone**. The names you see in the
"Invite" list are shown from your device only.

## How we use it — matching and inviting, nothing else
- To show you which of your contacts already have an Open Lounge account ("Friends on Open Lounge"), so you can follow them.
- To tell you, if you have **Friends joining** notifications on, when one of your contacts creates an account
  ("Maya just joined Open Lounge"): within 24 hours of your last sync, or anytime while **Tell me when contacts join** is on.

We do **not** use contact data for advertising, profiling, or recommendations to other people; we do **not** sell,
rent or share it with anyone; we do **not** build profiles of people who aren't Open Lounge members; and we **never
message your contacts**. Invites are only sent by you: tapping **Invite** opens your phone's share sheet with a link,
and you choose whether and how to send it.

## How long we keep it
- On our server each code is further protected with a secret key (HMAC "pepper"), so the stored value can't be
  looked up against a list of phone numbers without that key.
- Codes for numbers that **matched** an existing member are not stored at all — the match is returned to your phone and discarded.
- Codes for numbers that **did not match** are kept for at most **24 hours** (only so we can tell you if that
  contact joins in the meantime), then deleted automatically.
- If you turn on **Tell me when contacts join** (Invite friends, off by default), those codes are kept while the switch is
  on, only so we can tell you when one of those contacts joins. Turning the switch off deletes them right away.
- **Delete uploaded contacts** (Invite friends screen) or turning the feature off deletes everything you uploaded immediately.
- Deleting your account deletes your uploaded codes.

## Your choices
Turn **Tell me when contacts join** off or delete uploaded contacts anytime in **Settings → Invite friends**. Revoke contacts access in
your phone's Settings → Open Lounge → Contacts.

---
### Implementation notes (for reviewers / App Store Review 5.1.1, 5.1.2)
- Pre-permission explainer: `src/app/invite/page.tsx` (sheet shown before `OpenLoungeNative.requestContacts()` triggers the OS prompt).
- iOS `NSContactsUsageDescription` (Expo `app.json`): "Open Lounge checks which of your contacts are already members so you can follow them. Numbers are sent only as one-way codes, are never shared, and you can delete them anytime."
- Android: `READ_CONTACTS` runtime permission requested only from the same flow.
- Server: `server/push/contacts.ts`, `server/push/notifier.ts#matchContacts`, table `contact_hashes` (migration 007; `keep` column migration 024), hourly purge (`purgeExpiredHashes`, TTL 24 h for rows with keep = false), `POST /api/contacts/delete`, pref `contactsKeep` (turning it off deletes all of the owner's rows).
- Requires the server env `CONTACTS_PEPPER` (random secret) in production.
