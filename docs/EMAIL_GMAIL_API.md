# Email via the Gmail API (HTTPS)

Railway disables outbound SMTP on Free/Trial/Hobby plans ("SMTP is only available on the Pro plan and above" —
docs.railway.com/reference/outbound-networking), so Open Lounge can send its sign-in codes, add-email codes, and
password-reset mail through the **Gmail API** over HTTPS (`users.messages.send` with a raw RFC 2822 message).
There's no third-party email service and no new dependency. Code: `server/authx/gmail.ts`, selected in `server/authx/mailer.ts`.

## 1. Google Cloud (project `open-lounge-2aabd`)
1. Console → APIs & Services → Library → **Gmail API** → Enable.
2. OAuth consent screen (Google Auth Platform): User type **External**. App name "Open Lounge", support email = the sender.
   Data access / Scopes: add `https://www.googleapis.com/auth/gmail.send` (only this one).
3. Audience: either add the sender Gmail address as a **Test user** (Testing), or **Publish app** (see expiry note below).
4. Clients → Create client → Application type **Desktop app** → copy the client ID and secret.

## 2. Get a refresh token (one-time, local)
```bash
GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... node scripts/gmail-oauth.mjs
```
Open the printed URL in a browser on the same machine (the redirect goes to `http://127.0.0.1:53682/callback`). Sign in
**as the sender account**, then allow access. The script prints the refresh token. Treat it like a password.

### Testing vs. published: why the token expires after 7 days
When the consent screen is in **Testing**, Google issues refresh tokens that **expire after 7 days**. Email would quietly
stop working after a week, and the server log would show `invalid_grant ... 7 days`. To avoid that, click **Publish app**
(In production). `gmail.send` is a *sensitive* scope, so Google would normally require verification. For a personal or
low-volume app used only by its own account, you can stay unverified: the consent screen shows an "unverified app"
warning (Advanced → Go to Open Lounge), there's a 100-user cap on new grants, and refresh tokens don't expire after 7 days.
After publishing, run the script again to get a long-lived token. A token stops working if you revoke it, change the
password (with Gmail scopes), or leave it unused for 6 months.

## 3. Railway variables (service settings; don't commit these)
| Var | Value |
|---|---|
| `MAIL_TRANSPORT` | `gmail_api` (or `smtp`; unset = Gmail API if configured, else SMTP) |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` | from step 1 |
| `GMAIL_REFRESH_TOKEN` | from step 2 |
| `GMAIL_SENDER` | the Gmail address, e.g. `openlounge.app@gmail.com` (must be the account that consented) |
| `MAIL_REPLY_TO` | optional |
| `GMAIL_DAILY_LIMIT` | optional local cap, default 450 |

When either transport is configured, email sign-in is turned on in production.

## Notes
- **From** is `"Open Lounge" <GMAIL_SENDER>`. Gmail signs as gmail.com, so the From has to be that Gmail address to pass
  DMARC. A custom `@openlounge.app` From would fail DMARC unless it's a Google Workspace domain with its own DKIM.
- **Quotas:** consumer Gmail allows about 500 recipients/day. On a 429 or a quota 403, the server logs a clear
  `[mail] gmail_api send failed ... Gmail quota exceeded` and pauses sending (60 min for daily limits, 5 min for rate
  limits). The local cap, plus the existing per-IP/per-email OTP rate limits and resend cooldown, keeps sending under the limit.
  Users still get the generic response, because sending never throws to callers.
- Tokens, secrets, and message bodies are never logged. Recipients are masked.
