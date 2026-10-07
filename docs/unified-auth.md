# Open Lounge — unified sign-in (phone · email · Apple · Google)

Branch `unified-auth` (worktree `/workspace/openlounge-auth`, based on `origin/main` 9a87ffb). **Not merged, not deployed.**
Nothing changes visibly in production until the env vars below are set: with none of them, the login screen is
phone-only, exactly as today (verified by screenshot + tests).

## What's built

**One account, many sign-in methods.** One `users` row per person. Every way of signing in is a row in
`auth_identities` (`provider` = `phone` | `email` | `google` | `apple`, `provider_subject` = E.164 number / lower-cased
email / the provider's `sub`). **Phone is a first-class identity like the others:** phone OTP signup creates a
`phone` identity, and phone OTP login looks the account up through `auth_identities` (existing numbers are backfilled by
migration 005; `users.phone` stays as a mirror for `/auth/validate`'s `phoneMasked` and as a fallback). Profile
(name, username, bio, avatar, interests), follows, rooms and DMs belong to the user, so they're the same whichever method
signs in. A phone-registered user can add email/Apple/Google later and vice versa — all land on the same account
(tested: phone user links Google → signs in with Google → same profile + DMs; email user adds phone → phone OTP opens
the email account).

All methods issue the **same v2 session** (`store.createSession`: access token + rotating hashed refresh token), so
`GET /auth/validate`, `POST /auth/refresh`, `POST /auth/logout` and ws `session:resume` are untouched.

**Linking rules** (`server/authx/accounts.ts`)
1. `(provider, subject)` already known → that account.
2. Else the provider says the email is **verified** and exactly **one** account owns a **verified** identity with that
   email (any provider) → the new identity is attached to that account.
3. Else → new account through the existing onboarding (name → username → photo → bio → interests → follow).
   Unverified emails never link; two accounts with the same verified email → never guess (new account).
- Settings → "Ways to sign in": list methods, remove (never the last one), add phone (OTP), add email + password
  (confirm link), connect Apple / Google. Linking an identity owned by another account is refused.

**Google** — server-side authorization-code flow with PKCE (S256), `state`, `nonce`; ID token verified against Google's
JWKS (signature RS256, `iss`, `aud`, `exp`, `iat`, `nonce`; `email_verified` decides linking).
**Apple** — Sign in with Apple web flow, `response_mode=form_post`, POST callback; client secret = ES256 JWT
(iss = team `9A6NA2ZAFH`, sub = Services ID, kid = key id; cached ~1 h); ID token verified against Apple's JWKS;
first-time-only `user` JSON (name) is used to pre-fill onboarding; private-relay emails handled (shown as "Hidden email
(Apple relay)"; `email_verified` "true" strings accepted).
**OAuth state** — AES-256-GCM sealed httpOnly cookie `ol_oauth_<provider>` (Path=/auth/<provider>/, 10 min; Google
SameSite=Lax, Apple SameSite=None; Secure because form_post is a cross-site POST) holding state, PKCE verifier, nonce,
return mode and (link mode) the user id — the callback must come back to the same browser (login-CSRF safe). Start
redirects to the canonical host (AUTH_PUBLIC_URL / https://openlounge.app) first so the cookie lives where the provider
returns.
**One-time code exchange** — callbacks never put a session in a URL: they redirect to `/auth/complete?code=…` (web) or
`openlounge://auth?code=…` (native shells, `?app=1`), and `POST /auth/exchange` turns the 5-minute single-use code
(SHA-256 stored) into a session / signup ticket / "linked". Shells add a PKCE-style `cc` challenge so a code
intercepted from the deep link is useless without the verifier kept in the WebView.
**Email** — sign up (email + password → verification link, 24 h) → existing onboarding; login; `/forgot-password`
(always the same generic answer, no enumeration; also lets Google/Apple-only users with a verified email set a password);
`/reset-password?token=…` (token stripped from the URL, sets the password, **revokes every session of that user**,
supersedes other outstanding links). Passwords: scrypt (N=32768, r=8, p=1, 16-byte salt) via node:crypto; timing-equal
"unknown email" path. Reset tokens: 32 random bytes, SHA-256 at rest, 30 min, single use (atomic
`UPDATE … WHERE used_at IS NULL`).
**Rate limits** (per process, sliding window) — login 20/15 min per IP + 8/15 min per email; forgot 10/h per IP
(429) + 3/h per email (silently no mail, same response); reset 10/15 min per IP + 5/h per email; signup 10/h per IP +
3/h per email; exchange/verify 30/10 min per IP; OAuth start 30/10 min per IP. IP = right-most X-Forwarded-For hop
(TRUST_PROXY_HOPS, default 1) so clients can't choose their bucket.
**SMTP** — nodemailer (only new dependency, MIT, free). Branded HTML + text templates (verify, already-registered,
reset/set password). Not configured → never crashes: dev logs the email and link; production logs a redacted line only.
SMTP errors are logged and the user still gets the generic success.
**Feature flags** — `GET /auth/providers` → `{phone:true, email, google, apple}`; each button renders only when all of
its env vars are present (Apple also needs a parseable key). Email needs SMTP (or `AUTH_EMAIL_DEV=1`, dev only).
**UI** — Clubhouse-style, light/dark: "Continue with Apple / Google / email" under the phone CTA on the welcome screen
and under "Next" on the phone screen (Apple: white-on-dark / black-on-light, Apple logo, system font, same size; Google:
standard G, neutral themes). Email sign-in / sign-up / "check your inbox", `/forgot-password`, `/reset-password`,
`/verify-email`, `/auth/complete`, Settings "Ways to sign in". Silent session handling unchanged; inline friendly
messages only for form errors (wrong password, weak password, expired link). Inside native shells the Google/Apple
buttons stay hidden until the shell implements `OpenLoungeNative.openAuth` (see below); email works there today.
**Security** — CORS allowlist unchanged (JSON routes still echo exact allowed origins / 403 others); only the
browser-navigation routes `/auth/{google,apple}/{start,callback}` bypass the CORS check (they answer with redirects and
are protected by the sealed state cookie). No secrets, codes or tokens are logged (audited server logs); emails masked.
No paid services and no SMS vendor were added; only env vars are read.

## Endpoints (also under /api/auth/*)
| Method | Path | |
|---|---|---|
| GET | /auth/providers | which buttons to show |
| GET | /auth/google/start `[?app=1&cc=…][&intent=…]` | → accounts.google.com |
| GET | /auth/google/callback | → /auth/complete?code=… or openlounge://auth?code=… |
| GET | /auth/apple/start `[?app=1&cc=…][&intent=…]` | → appleid.apple.com (form_post) |
| POST | /auth/apple/callback | form_post from Apple → 303 same targets |
| POST | /auth/exchange `{code, codeVerifier?}` | → session (`status:"existing"`) · `{status:"new", ticket, profile}` · `{status:"linked"}` |
| POST | /auth/email/signup `{email,password}` | always `{ok:true}` |
| POST | /auth/email/verify `{token}` | session · new (ticket) · linked · exists |
| POST | /auth/email/login `{email,password}` | session or 401 friendly |
| POST | /auth/password/forgot `{email}` | always `{ok:true}` |
| POST | /auth/password/reset `{token,password}` | revokes all sessions |
| GET | /auth/identities (Bearer) | my sign-in methods |
| POST | /auth/identities/remove `{id}` (Bearer) | never the last one |
| POST | /auth/link/start `{provider, app?, cc?}` (Bearer) | → `{url}` to start Google/Apple in link mode |
| POST | /auth/email/link `{email,password}` (Bearer) | add email + password (after the emailed link) |
| ws | `account:linkPhone {phone, code}` | add phone (code from `auth:requestCode`) |
| ws | `auth:register {ticket,…}` | unchanged; now also redeems email/Google/Apple tickets |
Unchanged: GET /auth/validate, POST /auth/refresh, POST /auth/logout, ws auth:requestCode / auth:verifyCode / session:resume.

## Schema — migration `005_unified_auth.sql` (additive, idempotent)
`auth_identities(user_id → users, provider CHECK phone|email|google|apple, provider_subject, email, verified, created_at,
last_used_at, UNIQUE(provider, provider_subject))` + indexes; `users.password_hash`; `password_reset_tokens(token_hash PK,
user_id, email, created_at, expires_at, used_at)`; `auth_one_time_codes(code_hash PK, purpose, payload jsonb, created_at,
expires_at, used_at)` for verification links / exchange codes / link intents; backfill of every existing `users.phone`
as a verified phone identity. Nothing dropped or rewritten. Tested on a copy of today's schema (001–004 + legacy
sessions): backfill correct, re-run is a no-op, existing phone users log in to the same account, old tokens validate.

## Env vars
| Var | For |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google button |
| `APPLE_TEAM_ID` (=9A6NA2ZAFH), `APPLE_SERVICES_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (.p8 contents; literal `\n` ok) | Apple button |
| `SMTP_HOST`, `SMTP_PORT` (587 STARTTLS / 465 TLS), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Email button + reset/verify mail |
| `AUTH_PUBLIC_URL` (optional; prod default https://openlounge.app) | redirect URIs + email links |
| `TRUST_PROXY_HOPS` (optional, default 1) | rate-limit client IP |
| `AUTH_EMAIL_DEV=1` (dev only, ignored in production) | email without SMTP, links in server log |

## External setup Donny must do (additive only)
**Google** (free)
1. console.cloud.google.com → create/select a project → *APIs & Services → OAuth consent screen*: External, app name
   "Open Lounge", support email, authorized domain `openlounge.app`, scopes `openid`, `email`, `profile` (non-sensitive —
   no Google verification review needed for these); publish to "In production".
2. *Credentials → Create credentials → OAuth client ID → Web application*.
   Authorized JavaScript origin `https://openlounge.app`; Authorized redirect URI **`https://openlounge.app/auth/google/callback`**.
3. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` on the Railway service.

**Apple** (team 9A6NA2ZAFH; needs the existing paid developer membership, nothing new to buy). **Create new items only —
do not modify, revoke or regenerate any existing App IDs, keys, certificates or profiles of other apps.**
1. developer.apple.com → Certificates, IDs & Profiles → Identifiers: when the App ID **com.donnydey.openlounge** exists
   (create it if not, explicit bundle ID), enable the **Sign in with Apple** capability on it (primary App ID).
2. Identifiers → **+** → **Services IDs** → new identifier, e.g. `app.openlounge.web` (this is `APPLE_SERVICES_ID`),
   description "Open Lounge Web". Enable **Sign in with Apple** → Configure: primary App ID com.donnydey.openlounge;
   Domains `openlounge.app`; Return URL **`https://openlounge.app/auth/apple/callback`**. Save.
3. Keys → **+** → new key "Open Lounge Sign in with Apple", enable **Sign in with Apple** (configure → com.donnydey.openlounge).
   Download the `.p8` once (Apple won't show it again). Key ID = `APPLE_KEY_ID`; file contents = `APPLE_PRIVATE_KEY`.
4. Set `APPLE_TEAM_ID=9A6NA2ZAFH`, `APPLE_SERVICES_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` on Railway.
5. If Apple asks to verify the domain, it gives you a file: commit it as
   `public/.well-known/apple-developer-domain-association.txt` and redeploy (nothing else needed).
6. (Email relay) To deliver mail to Apple private-relay addresses, register the SMTP sender domain/address under
   Certificates, IDs & Profiles → Services → Sign in with Apple for Email Communication (SPF/DKIM on the sending domain).

**SMTP sender** (pick one; all have free tiers, no card needed for the first few): Brevo (300/day free), Resend (3,000/mo,
100/day), Mailjet (6,000/mo, 200/day), SMTP2GO (1,000/mo), Amazon SES (cheap, not free after year 1), or a Gmail /
Google Workspace account with an app password (~500/day, fine for low volume). Verify `openlounge.app` as a sending
domain (SPF + DKIM DNS records), then set `SMTP_HOST`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASS`,
`SMTP_FROM="Open Lounge <hello@openlounge.app>"`.

## Tests (local Postgres 17 cluster on 127.0.0.1:55433 — never prod)
`npm run test:auth` → **32/32 pass** (unit 8, integration 19, migration 5): linking rules (identity, verified-email,
unverified never, ambiguity, Settings link/taken, phone one-per-account), Google + Apple full round trips against mock
providers with locally generated JWKS (PKCE checked by the mock, Apple ES256 client secret verified by the mock, state /
cookie / nonce / audience / signature / provider-cancel failures, one-time code single use, deep-link + verifier,
canonical host), email signup/verify/login, phone↔email↔Google cross-linking, reset token lifecycle (generic forgot,
30-min expiry, single use, weak password keeps token, supersede, all sessions revoked, Google-only "set a password"),
rate limits (login/forgot/reset per IP & per email), provider-flag gating, CORS, migration 005 backfill/idempotency, and
regression: phone OTP signup/login + `GET /auth/validate` 200/401 + refresh/logout unchanged. Also `tsc` clean, `next build`
OK, existing `scripts/smoke-ws.mjs` ALL PASSED. Playwright (two local production servers: no env vs fake env + local
SMTP sink, real nodemailer delivery): **34/34 checks** incl. full email signup → onboarding → Settings add phone → forgot →
reset → old link refused → sign in with new password → phone OTP opens the same account.

Screenshots: `/workspace/unified-auth-screens/` (light + dark): 01–02 no providers (unchanged), 03–04 all providers,
05 OAuth cancelled, 06–07 email sign-in (+ wrong password), 08–10 email signup / check inbox / verified → onboarding,
11–12 Settings ways to sign in / add phone, 13–14 forgot password, 15–17 reset / done / used link, 18 email templates.

## What's left
- **Native wrappers (not changed — TODO):** the server side is done; Google blocks OAuth in embedded WebViews, so:
  - Both shells: expose `OpenLoungeNative.openAuth(url)` (the web hides Google/Apple until it exists). Open `url` in the
    system browser; when `openlounge://auth?…` comes back, load `https://openlounge.app/auth/complete?<same query>` in
    the WebView. The web page redeems the code (with the verifier it stored) and saves the session via the existing
    `OpenLoungeNative.setSession`. No token ever passes through the shell.
  - Android: `addJavascriptInterface` method `openAuth` → `CustomTabsIntent` (androidx.browser); manifest intent-filter on
    the activity (`singleTask`) for scheme `openlounge`, host `auth`; in `onNewIntent` → `webView.loadUrl(BASE + "/auth/complete?" + uri.query)`.
  - Expo iOS: `expo-web-browser` `openAuthSessionAsync(url, "openlounge://auth")` (ASWebAuthenticationSession) via the
    existing postMessage bridge; add `"scheme": "openlounge"` to app.json; on success inject
    `location.replace("/auth/complete?" + query)`. Native "Sign in with Apple" (expo-apple-authentication) is optional later.
  - Optional hardening: Android App Links / iOS Universal Links (`https://openlounge.app/auth/complete`) instead of the custom scheme.
- **App Store Guideline 4.8:** an iOS app that offers a third-party login like Google must also offer Sign in with Apple
  (or an equivalent privacy-focused option) — so turn Google on in the iOS app only together with Apple. Also App Store 5.1.1(v): apps with account creation must offer in-app account deletion
  (not built yet).
- Phone OTP is still demo mode in prod (code on screen / 000000) — this also means "add phone" can claim any unused number.
  A real SMS provider is needed before public launch (not touched here).
- Rate limits are in-memory per instance (reset on deploy). Fine for one Railway instance.
- Merge + deploy: merge `unified-auth` after review (expect small conflicts only if main touched `server/index.ts` /
  `realtime.ts`), deploy; migration 005 runs automatically at boot. Then add env vars provider by provider.
