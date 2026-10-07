# Username sign-in (@username)

Sign in with your screen name (`@donnydey`, `donnydey`, `DonnyDey`; case-insensitive, leading `@` stripped) into the
same unified account as phone / Google / Apple / email. A username is public, so it's never a credential by itself:

1. **@username + password**: `POST /auth/username/login {username,password}`. The password is the *account* password
   (`users.password_hash`, scrypt N=2^15 r=8 p=1, 16-byte salt, `timingSafeEqual`), the same one email+password uses.
   Set / change / remove it in Settings > Linked sign-in methods > "Username & password"
   (`POST /auth/password/set|remove`, Bearer; min 8 chars; changing/removing needs the current password).
   Unknown username, no password set, or wrong password all get the same
   `401 {"error":"Username or password is incorrect"}` after the same scrypt work (dummy verify).
   Limits: 30 tries / 15 min per IP; lockout after 5 failures per username+IP (15 min) and 20 failures per username
   from any IP (1 h). Only failures count. Keyed by the normalized string whether or not the account exists.
2. **Send me a code instead**: `POST /auth/username/code/start {username}` emails a 6-digit code to the account's
   verified email (email identity first, else a verified Google/Apple email) and answers with the masked destination
   (`d***@gmail.com`) and masked phone (`•••• 0142`) if the account has one. `POST /auth/username/code/verify
   {username,code}` returns a session. Codes reuse the 010 table (`email_otp_codes`, purpose `username`): HMAC-keyed
   hash, 10 min, 5 attempts, single use, 60 s resend cooldown, 5 codes/user/hour. Lookups: 15 / hour per IP.
   Unknown username: `200 {ok:true,sent:false,email:null,phone:null}` (nothing sent).
   Phone: Firebase Phone Auth sends the SMS from the client, so the server can't text a number the client doesn't
   know. We show the masked number and hand off to the regular phone sign-in screen.

Both paths return `sessionBody()`, the same v2 access + rotating refresh session as every other method.

**Migration 012** (`012_username_signin.sql`): adds `'username'` to `email_otp_codes.purpose` and an index on
`lower(users.username)`. 010 = email OTP (email-otp branch), 011 = reserved by ugc-safety.
Removing the last email identity no longer clears the password (it still serves @username sign-in).

Known limits: rate limits and lockouts are in-memory per process (like the existing limiter) and reset on deploy.
The masked destination inherently confirms that a username has a verified email (rate limited).
